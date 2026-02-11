/**
 * Enrich Vapi Call Data - Generic GPT-powered classification
 *
 * Usage: node enrich.js --client=bathfitter [--batch-size=50]
 *
 * This script classifies calls using GPT with client-specific business context.
 */

// Load client-specific .env first, then fall back to root .env
require('dotenv').config({ path: require('path').join(__dirname, '../clients', process.argv.find(a => a.startsWith('--client='))?.split('=')[1] || '', '.env') });
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const OpenAI = require('openai');
const { format } = require('date-fns');
const { loadClientConfig } = require('../core/config-loader');
const { buildEnrichmentPrompt, buildBusinessContext } = require('../core/prompt-builder');
const {
    loadAllEnrichments,
    saveEnrichments,
    getUnenrichedCalls
} = require('../core/lib/store_enrichment');

// Parse command line arguments
const args = process.argv.slice(2);
const clientArg = args.find(arg => arg.startsWith('--client='));
const batchSizeArg = args.find(arg => arg.startsWith('--batch-size='));

if (!clientArg) {
    console.error('Error: --client argument is required');
    console.error('Usage: node enrich.js --client=<clientname> [--batch-size=50]');
    process.exit(1);
}

const clientName = clientArg.split('=')[1];
const BATCH_SIZE = batchSizeArg ? parseInt(batchSizeArg.split('=')[1]) : 50;

// Load client configuration
const config = loadClientConfig(clientName);
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

console.log(`=== Enriching calls for ${config.client.name} ===`);
console.log(`AI Assistant: ${config.client.aiAssistantName}`);
console.log(`Batch size: ${BATCH_SIZE}`);

if (!OPENAI_API_KEY) {
    console.error('Error: OPENAI_API_KEY environment variable is not set.');
    process.exit(1);
}

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

/**
 * Load all raw calls from data/raw directory
 */
function loadAllRawCalls() {
    const rawFiles = fs.readdirSync(config.paths.rawDir).filter(f => f.endsWith('.json'));
    const allCalls = [];

    for (const file of rawFiles) {
        const filePath = path.join(config.paths.rawDir, file);
        const calls = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        allCalls.push(...calls);
    }

    return allCalls;
}

/**
 * Classify a batch of calls using GPT
 */
async function classifyCallsBatch(calls) {
    // Build prompts from config
    const promptData = buildEnrichmentPrompt(config);

    // Prepare call data for GPT with critical metadata
    const callSummaries = calls.map((call, idx) => {
        const duration = call.endedAt && call.startedAt
            ? Math.round((new Date(call.endedAt) - new Date(call.startedAt)) / 1000)
            : 0;

        // Extract transfer destination hint from toolCalls
        let transferDestination = null;
        if (call.messages) {
            for (const msg of call.messages) {
                if (msg.toolCalls) {
                    const transferTool = msg.toolCalls.find(t =>
                        t.function?.name === 'intent_transfer' ||
                        t.function?.name === 'transfer_intent' ||
                        t.function?.name === 'transferCall'
                    );
                    if (transferTool?.function?.arguments) {
                        try {
                            const args = JSON.parse(transferTool.function.arguments);
                            transferDestination = args.destination || args.intent || null;
                        } catch (e) {}
                    }
                }
            }
        }

        // Check for booking completion in structured outputs
        let appointmentBooked = false;
        if (call.analysis?.artifact?.structuredOutputs?.['Appointment Booked']?.result === true) {
            appointmentBooked = true;
        }
        // Also check successEvaluation (may be a JSON string that needs parsing)
        // But be more careful: call_success=yes doesn't always mean booking-completed
        // It could mean successful transfer. Check final_outcome for actual appointment confirmation.
        if (call.analysis?.successEvaluation) {
            let evalData = call.analysis.successEvaluation;
            // Parse if it's a JSON string
            if (typeof evalData === 'string') {
                try {
                    evalData = JSON.parse(evalData);
                } catch (e) {
                    evalData = {};
                }
            }
            // Only set appointmentBooked=true if final_outcome indicates appointment was scheduled
            // NOT if it was just a successful transfer
            const finalOutcome = (evalData.final_outcome || '').toLowerCase();
            if (evalData.call_success === 'yes' &&
                (finalOutcome.includes('appointment') || finalOutcome.includes('consultation')) &&
                (finalOutcome.includes('scheduled') || finalOutcome.includes('confirmed') || finalOutcome.includes('booked')) &&
                !finalOutcome.includes('transferred')) {
                appointmentBooked = true;
            }
        }

        return {
            index: idx,
            callId: call.id,
            duration: duration,
            endedReason: call.endedReason || 'unknown',
            transferDestinationHint: transferDestination,
            appointmentBooked: appointmentBooked,
            transcript: call.transcript || '',
            summary: call.summary || 'No summary available'
        };
    });

    const userPrompt = promptData.user + '\n\n**CALLS TO CLASSIFY:**\n\n' +
        callSummaries.map((c, i) => {
            return `Call ${i + 1}:\n` +
                   `- ID: ${c.callId}\n` +
                   `- Duration: ${c.duration}s\n` +
                   `- endedReason: ${c.endedReason}\n` +
                   `- transferDestinationHint: ${c.transferDestinationHint || 'none'}\n` +
                   `- appointmentBooked: ${c.appointmentBooked}\n` +
                   `- Summary: ${c.summary}\n` +
                   `- Transcript: ${c.transcript.substring(0, 500)}...\n`;
        }).join('\n');

    try {
        const completion = await openai.chat.completions.create({
            model: 'gpt-4o-mini',
            messages: [
                { role: 'system', content: promptData.system },
                { role: 'user', content: userPrompt }
            ],
            temperature: 0.3,
            response_format: { type: 'json_object' }
        });

        const result = JSON.parse(completion.choices[0].message.content);

        // Map results back to calls with correct field names
        const enrichments = [];
        for (let i = 0; i < calls.length; i++) {
            const call = calls[i];
            const callMetadata = callSummaries[i];
            let classification = result.calls?.find(c => c.callId === call.id) || {
                category: 'unknown',
                hangupType: null,
                transferReason: null,
                spamType: null
            };

            // POST-PROCESSING OVERRIDES for when GPT classification is wrong/unknown

            // Override 1: appointmentBooked flag is definitive for booking-completed
            if (callMetadata.appointmentBooked === true && classification.category !== 'booking-completed') {
                console.log(`  Override: ${call.id} → booking-completed (appointmentBooked=true)`);
                classification = {
                    category: 'booking-completed',
                    hangupType: null,
                    transferReason: null,
                    spamType: null
                };
            }

            // Override 2: If GPT says "unknown" but endedReason is clear, use fallback rules
            if (classification.category === 'unknown') {
                const endedReason = callMetadata.endedReason;
                const duration = callMetadata.duration;

                if (endedReason === 'assistant-forwarded-call') {
                    // Transferred calls
                    console.log(`  Override: ${call.id} → transferred (assistant-forwarded-call)`);
                    classification = {
                        category: 'transferred',
                        hangupType: null,
                        transferReason: 'other',
                        spamType: null
                    };
                } else if (endedReason === 'customer-ended-call' || endedReason === 'silence-timed-out') {
                    if (duration < 10) {
                        // Very short calls are spam
                        console.log(`  Override: ${call.id} → spam (short duration: ${duration}s)`);
                        classification = {
                            category: 'spam',
                            hangupType: null,
                            transferReason: null,
                            spamType: 'short-call'
                        };
                    } else {
                        // Longer customer-ended calls are hangups
                        console.log(`  Override: ${call.id} → hangup (customer-ended-call)`);
                        classification = {
                            category: 'hangup',
                            hangupType: duration < 30 ? 'low-value' : 'moderate',
                            transferReason: null,
                            spamType: null
                        };
                    }
                }
            }

            enrichments.push({
                callId: call.id,
                createdAt: call.createdAt,
                enrichedAt: new Date().toISOString(),
                model: 'gpt-4o-mini',
                classification: {
                    category: classification.category,
                    // Use dedicated fields that report-intraday.js expects
                    hangupType: classification.hangupType || null,
                    transferReason: classification.transferReason || null,
                    spamType: classification.spamType || null,
                    bookingStatus: classification.category?.startsWith('booking') ? 'booking-attempt' : 'none'
                }
            });
        }

        return enrichments;

    } catch (error) {
        console.error('GPT classification error:', error.message);

        // Return fallback classifications with correct field names
        return calls.map(call => ({
            callId: call.id,
            createdAt: call.createdAt,
            enrichedAt: new Date().toISOString(),
            model: 'gpt-4o-mini',
            classification: {
                category: 'unknown',
                hangupType: null,
                transferReason: null,
                spamType: null,
                bookingStatus: 'none'
            }
        }));
    }
}

/**
 * Main enrichment process
 */
async function enrichCalls() {
    try {
        console.log('Loading raw calls...');
        const allCalls = loadAllRawCalls();
        console.log(`Total raw calls: ${allCalls.length}`);

        console.log('Loading existing enrichments...');
        const existingEnrichments = loadAllEnrichments(config.paths.enrichedDir);
        console.log(`Existing enrichments: ${existingEnrichments.size}`);

        console.log('Identifying unenriched calls...');
        const unenrichedCalls = getUnenrichedCalls(allCalls, existingEnrichments);
        console.log(`Calls to enrich: ${unenrichedCalls.length}`);

        if (unenrichedCalls.length === 0) {
            console.log('✅ All calls are already enriched!');
            return;
        }

        // Process in batches
        const totalBatches = Math.ceil(unenrichedCalls.length / BATCH_SIZE);
        let processedCount = 0;

        for (let i = 0; i < totalBatches; i++) {
            const batchStart = i * BATCH_SIZE;
            const batchEnd = Math.min(batchStart + BATCH_SIZE, unenrichedCalls.length);
            const batch = unenrichedCalls.slice(batchStart, batchEnd);

            console.log(`\nProcessing batch ${i + 1}/${totalBatches} (${batch.length} calls)...`);

            const enrichments = await classifyCallsBatch(batch);

            // Save enrichments
            saveEnrichments(enrichments, config.paths.enrichedDir);

            processedCount += enrichments.length;
            console.log(`✅ Batch complete: ${processedCount}/${unenrichedCalls.length} total`);

            // Rate limiting - wait 1 second between batches
            if (i < totalBatches - 1) {
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
        }

        console.log(`\n✅ Enrichment complete: ${processedCount} calls classified`);
        console.log(`Classification context: ${config.client.name} (${config.client.industry})`);

    } catch (error) {
        console.error('Enrichment failed:', error.message);
        process.exit(1);
    }
}

// Run enrichment
enrichCalls();

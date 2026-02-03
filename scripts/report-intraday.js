/**
 * Intraday Report - Generic script for any client
 *
 * Usage: node report-intraday.js --client=bathfitter [--date=2025-11-22]
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const OpenAI = require('openai');
const { format } = require('date-fns');
const { toZonedTime } = require('date-fns-tz');
const { loadClientConfig } = require('../core/config-loader');
const { classifyCall } = require('../core/lib/classify_call');

// Parse command line arguments
const args = process.argv.slice(2);
const clientArg = args.find(arg => arg.startsWith('--client='));
const dateArg = args.find(arg => arg.startsWith('--date='));

if (!clientArg) {
    console.error('Error: --client argument is required');
    console.error('Usage: node report-intraday.js --client=<clientname> [--date=2025-11-22]');
    process.exit(1);
}

const clientName = clientArg.split('=')[1];

// Load client configuration
const config = loadClientConfig(clientName);
const TIME_ZONE = config.client.timezone || 'America/New_York';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

console.log(`=== Generating intraday report for ${config.client.name} ===`);
console.log(`AI Assistant: ${config.client.aiAssistantName}`);
console.log(`Timezone: ${TIME_ZONE}`);

if (!OPENAI_API_KEY) {
    console.error('Error: OPENAI_API_KEY environment variable is not set.');
    process.exit(1);
}

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// Extract email from call data
function extractEmail(call) {
    let email = null;
    const emailRegex = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g;

    // 1. Check structured data (PRIMARY LOCATION - most reliable)
    if (call.analysis?.structuredData?.email) {
        email = call.analysis.structuredData.email;
    }

    // 2. Check structured data parameters wrapper (alternative format)
    if (!email && call.analysis?.structuredData?.parameters?.email) {
        email = call.analysis.structuredData.parameters.email;
    }

    // 3. Try structured outputs (legacy/alternative location)
    if (!email && call.analysis?.artifact?.structuredOutputs) {
        const outputs = Object.values(call.analysis.artifact.structuredOutputs);
        const emailOutput = outputs.find(output =>
            output.name === 'Email' ||
            output.name === 'email' ||
            output.name === 'Email Address' ||
            output.name === 'email_address' ||
            output.name === 'customerEmail'
        );
        if (emailOutput && emailOutput.result) {
            email = emailOutput.result;
        }
    }

    // 4. Check transcript (fallback - parse from conversation)
    if (!email && call.transcript) {
        const matches = call.transcript.match(emailRegex);
        if (matches && matches.length > 0) {
            // Return the last email mentioned (usually the one provided by customer)
            email = matches[matches.length - 1];
        }
    }

    // 5. Check summary
    if (!email && call.summary) {
        const matches = call.summary.match(emailRegex);
        if (matches && matches.length > 0) {
            email = matches[0];
        }
    }

    // 6. Check user messages only (not system prompt which may contain placeholder emails)
    if (!email && call.messages) {
        for (const msg of call.messages) {
            if (msg.message && msg.role === 'user') {
                const match = msg.message.match(emailRegex);
                if (match) {
                    email = match[0];
                    break;
                }
            }
        }
    }

    // 7. Check custom fields (if any)
    if (!email && call.customer?.email) {
        email = call.customer.email;
    }

    return email;
}

async function generateIntradayReport() {
    try {
        // 1. Get target date (from --date parameter or default to today)
        let targetDate;
        if (dateArg) {
            const dateStr = dateArg.split('=')[1];
            targetDate = new Date(dateStr + 'T12:00:00Z'); // Use noon UTC to avoid timezone issues
        } else {
            targetDate = new Date();
        }

        const todayZoned = toZonedTime(targetDate, TIME_ZONE);
        const todayStr = format(todayZoned, 'yyyy-MM-dd');

        // Always use NOW for the report generation timestamp
        const nowZoned = toZonedTime(new Date(), TIME_ZONE);
        const reportTimeStr = format(nowZoned, 'h:mm a');

        console.log(`\n=== Generating Intraday Report for ${todayStr} ===`);

        // 2. Load today's calls
        const rawFile = path.join(config.paths.rawDir, `vapi_calls_${todayStr}.json`);
        if (!fs.existsSync(rawFile)) {
            console.log(`No raw data file found for ${todayStr}. Exiting.`);
            return;
        }

        const allCalls = JSON.parse(fs.readFileSync(rawFile, 'utf8'));

        if (allCalls.length === 0) {
            console.log('No calls found for this date. Exiting.');
            return;
        }

        // 3. Load Existing Enrichments
        const enrichmentMap = new Map();
        if (fs.existsSync(config.paths.enrichedDir)) {
            const files = fs.readdirSync(config.paths.enrichedDir).filter(f => f.endsWith('.json'));
            files.forEach(file => {
                try {
                    const content = JSON.parse(fs.readFileSync(path.join(config.paths.enrichedDir, file), 'utf8'));
                    if (Array.isArray(content)) {
                        content.forEach(e => enrichmentMap.set(e.callId, e));
                    } else if (typeof content === 'object') {
                        Object.values(content).forEach(e => {
                            if (e && e.callId) enrichmentMap.set(e.callId, e);
                        });
                    }
                } catch (e) {
                    console.warn(`Warning: Could not parse ${file}`);
                }
            });
        }

        console.log(`Loaded ${enrichmentMap.size} enrichments`);

        // 4. Prepare data for report
        const processedCalls = allCalls.map(call => {
            const enrichment = enrichmentMap.get(call.id);

            // Use classifyCall for fresh data if no enrichment exists
            let category, bookingStatus, hangupType, transferReason, spamType;
            if (enrichment) {
                category = enrichment.classification?.category || 'unknown';
                bookingStatus = enrichment.classification?.bookingStatus || 'N/A';
                hangupType = enrichment.classification?.hangupType || null;
                transferReason = enrichment.classification?.transferReason || null;
                spamType = enrichment.classification?.spamType || null;
            } else {
                // Use local classification for instant results
                const localResult = classifyCall(call);
                if (localResult.needs_analysis) {
                    category = 'Unknown';
                    bookingStatus = 'Pending Analysis';
                } else {
                    category = localResult.category;
                    bookingStatus = localResult.bookingStatus;
                }
            }

            // Calculate duration from timestamps
            let duration = call.duration || 0;
            if (!duration && call.startedAt && call.endedAt) {
                const start = new Date(call.startedAt);
                const end = new Date(call.endedAt);
                duration = (end - start) / 1000; // Convert ms to seconds
            }

            // Extract email
            const email = extractEmail(call);

            return {
                id: call.id,
                createdAt: call.createdAt,
                customerNumber: call.customer?.number || 'Unknown',
                customerName: call.customer?.name || 'Unknown',
                email: email || 'N/A',
                duration: duration,
                summary: call.summary || 'No summary',
                category: category,
                bookingStatus: bookingStatus,
                hangupType: hangupType,
                transferReason: transferReason,
                spamType: spamType,
                endedReason: call.endedReason
            };
        });

        // Enrich calls with classification data
        const enrichedCalls = processedCalls.map(call => {
            return {
                id: call.id,
                createdAt: call.createdAt,
                customerNumber: call.customerNumber || 'Unknown',
                customerName: call.customerName || 'Unknown',
                email: call.email || 'N/A',
                duration: call.duration || 0,
                summary: call.summary || 'No summary',
                category: call.category,
                bookingStatus: call.bookingStatus,
                hangupType: call.hangupType,
                transferReason: call.transferReason,
                spamType: call.spamType,
                endedReason: call.endedReason
            };
        });

        // 5. Calculate metrics (using unified taxonomy)
        const metrics = {
            totalCalls: enrichedCalls.length,
            bookingSuccess: enrichedCalls.filter(c => c.category?.toLowerCase() === 'booking-completed').length,
            bookingAbandoned: enrichedCalls.filter(c => c.category?.toLowerCase() === 'booking-abandoned').length,
            bookingTransferred: enrichedCalls.filter(c => c.category?.toLowerCase() === 'booking-transferred').length,
            eligibleLeads: enrichedCalls.filter(c => ['booking-completed', 'booking-abandoned', 'booking-transferred'].includes(c.category?.toLowerCase())).length,
            totalBookingAttempts: enrichedCalls.filter(c => ['booking-completed', 'booking-abandoned', 'booking-transferred'].includes(c.category?.toLowerCase())).length,
            transferred: enrichedCalls.filter(c => c.category?.toLowerCase() === 'transferred').length,
            spam: enrichedCalls.filter(c => c.category?.toLowerCase() === 'spam').length,
            hangup: enrichedCalls.filter(c => c.category?.toLowerCase() === 'hangup').length,
            hangupHighValue: enrichedCalls.filter(c => c.category?.toLowerCase() === 'hangup' && c.hangupType === 'high-value').length,
            hangupModerate: enrichedCalls.filter(c => c.category?.toLowerCase() === 'hangup' && c.hangupType === 'moderate').length,
            hangupLowValue: enrichedCalls.filter(c => c.category?.toLowerCase() === 'hangup' && c.hangupType === 'low-value').length,
            other: enrichedCalls.filter(c => !['booking-completed', 'booking-abandoned', 'booking-transferred', 'transferred', 'spam', 'hangup'].includes(c.category?.toLowerCase())).length
        };

        metrics.successRate = metrics.eligibleLeads > 0
            ? ((metrics.bookingSuccess / metrics.eligibleLeads) * 100).toFixed(1)
            : 0;

        metrics.containmentRate = metrics.eligibleLeads > 0
            ? ((metrics.bookingSuccess / metrics.eligibleLeads) * 100).toFixed(1)
            : 0;

        // KPI Waterfall Rates
        metrics.grossConvRate = metrics.totalCalls > 0
            ? ((metrics.bookingSuccess / metrics.totalCalls) * 100).toFixed(1)
            : 0;

        metrics.eligConvRate = metrics.eligibleLeads > 0
            ? ((metrics.bookingSuccess / metrics.eligibleLeads) * 100).toFixed(1)
            : 0;

        metrics.bookSuccessRate = metrics.totalBookingAttempts > 0
            ? ((metrics.bookingSuccess / metrics.totalBookingAttempts) * 100).toFixed(1)
            : 0;

        // Transfer breakdown by reason
        const transferReasons = {};
        enrichedCalls
            .filter(c => c.category?.toLowerCase() === 'transferred' || c.category?.toLowerCase() === 'booking-transferred')
            .forEach(c => {
                const reason = c.transferReason || 'unspecified';
                transferReasons[reason] = (transferReasons[reason] || 0) + 1;
            });
        metrics.transferReasons = transferReasons;

        console.log(`Metrics - Total: ${metrics.totalCalls}, Eligible: ${metrics.eligibleLeads} (Success: ${metrics.bookingSuccess}, Abandoned: ${metrics.bookingAbandoned}, Transferred: ${metrics.bookingTransferred}), NonBooking-Transferred: ${metrics.transferred}, Spam: ${metrics.spam}, Hangup: ${metrics.hangup} (High: ${metrics.hangupHighValue}, Mod: ${metrics.hangupModerate}, Low: ${metrics.hangupLowValue}), Other: ${metrics.other}`);

        // 6. Generate Report with detailed metrics
        const aiName = config.client.aiAssistantName;
        const businessName = config.client.name;
        const businessDesc = config.client.description || '';

        // Build call purposes list
        let callPurposesList = '';
        if (config.client.callPurposes && config.client.callPurposes.length > 0) {
            callPurposesList = config.client.callPurposes.map(p => `- ${p}`).join('\n');
        }

        const reportPrompt = `
You are writing an **Intraday Status Report** for the ${businessName} executive team.

**BUSINESS CONTEXT:**
${businessName} is ${businessDesc}. ${aiName} (AI assistant) handles inbound calls to:
${callPurposesList}

**Context**:
- Date: ${todayStr}
- Time: ${reportTimeStr} ${TIME_ZONE.split('/')[1]}
- Total Calls So Far: ${metrics.totalCalls}

**Metrics**:
- Booking Success: ${metrics.bookingSuccess}
- Eligible Leads: ${metrics.eligibleLeads}
- Total Booking Attempts (including transfers): ${metrics.totalBookingAttempts}
- Success Rate: ${metrics.successRate}%
- Containment Rate: ${metrics.containmentRate}%
- Transferred: ${metrics.transferred}
- Spam: ${metrics.spam}
- Hangup: ${metrics.hangup}
- Other: ${metrics.other}

**Call Data**:
${JSON.stringify(enrichedCalls, null, 2)}

**IMPORTANT - Seasonality & Business Patterns:**
Apply your knowledge of typical business call patterns when analyzing trends:

- **Day-of-Week (DOW)**: Weekends (especially Sundays) naturally have much lower volume than weekdays. A "low" Sunday is normal, not alarming.
- **Week-of-Month (WOM)**: First/last weeks may differ from mid-month patterns.
- **Month-of-Year (MOY)**: Summer months, December holidays typically show different patterns.
- **Holidays**:
  - Thanksgiving week (4th Thursday of Nov) and the weekend after are predictably slow
  - Christmas/New Year (Dec 24 - Jan 2) is a known slow period
  - July 4th week, Memorial Day, Labor Day weekends are slower

When you see low volume, ask yourself: "Is this expected given the day/week/season?"
- Don't alarm about a slow Sunday or post-Thanksgiving Saturday
- DO flag if a Tuesday is unusually slow with no obvious explanation

**Statistical Context:**
- This is an intraday report - volume is naturally lower than a full day
- Compare patterns to time-of-day expectations (morning vs afternoon)
- Focus on actionable insights, not alarm

**Requirements**:

# Intraday Status Report - ${todayStr} (${reportTimeStr} ${TIME_ZONE.split('/')[1]})

## Executive Summary
(3 concise paragraphs covering today's performance, key trends, and notable patterns)

## Today's Performance

| Metric | Count | % |
|--------|-------|---|
| Total Calls | ${metrics.totalCalls} | 100% |
|--------|-------|---|
| Eligible Leads | ${metrics.eligibleLeads} | - |
| → Booking Success | ${metrics.bookingSuccess} | ${metrics.successRate}% |
| → Booking Abandoned | ${metrics.bookingAbandoned} | - |
| → Booking Transferred | ${metrics.bookingTransferred} | - |
| Transferred (no booking attempt) | ${metrics.transferred} | - |
| Spam | ${metrics.spam} | - |
| Hangup (high-value - callback priority) | ${metrics.hangupHighValue} | - |
| Hangup (moderate - medium priority) | ${metrics.hangupModerate} | - |
| Hangup (low-value - skip callbacks) | ${metrics.hangupLowValue} | - |
| Other | ${metrics.other} | - |

**Success Rate**: ${metrics.successRate}%
**Containment Rate**: ${metrics.containmentRate}%

## KPI Waterfall
| Metric | Value |
|--------|-------|
| Gross Conv % (Booked/Total) | ${metrics.grossConvRate}% |
| Elig Conv % (Booked/Eligible) | ${metrics.eligConvRate}% |
| Book Success % (Booked/Attempts) | ${metrics.bookSuccessRate}% |

## Transfer Breakdown by Reason
| Reason | Count | % of Transfers |
|--------|-------|----------------|
${Object.entries(metrics.transferReasons).length > 0
    ? Object.entries(metrics.transferReasons).map(([reason, count]) => {
        const totalTransfers = metrics.transferred + metrics.bookingTransferred;
        const pct = totalTransfers > 0 ? ((count / totalTransfers) * 100).toFixed(1) : 0;
        return `| ${reason} | ${count} | ${pct}% |`;
    }).join('\n')
    : '| No transfers | 0 | 0% |'}

## Repeat Numbers Analysis
(Identify any phone numbers that called multiple times today and provide brief context)

## Call Log

Create an HTML table with these columns:
- Time (${TIME_ZONE.split('/')[1]})
- Caller #
- Email
- Duration
- Category
- Status/Type (show "N/A" for booking calls, hangupType for hangup calls, transferReason for transfers, spamType for spam)
- Summary

**IMPORTANT - Color coding based on category AND substatus (apply to entire <tr>):**
- booking-completed: style="color: #2e7d32; font-weight: bold;" (green bold)
- booking-abandoned: style="color: #ff6f00; font-weight: bold;" (orange bold - high-value lead)
- booking-transferred: style="color: #ff6f00; font-weight: bold;" (orange bold)
- hangup (high-value): style="color: #ff9800; font-weight: bold;" (amber bold - callback priority)
- hangup (moderate): style="color: #fbc02d;" (yellow - medium priority)
- hangup (low-value): style="color: #c62828;" (red - low priority)
- transferred: style="color: #1565c0;" (blue)
- spam: style="color: #757575;" (gray)
- All other rows: no color styling

Use this format:
<table border="1" style="border-collapse: collapse; width: 100%;">
  <tr style="background-color: #f5f5f5;">
    <th style="padding: 8px; border: 1px solid #ddd;">Time (${TIME_ZONE.split('/')[1]})</th>
    ...
  </tr>
  ...
</table>
`;

        const reportResult = await openai.chat.completions.create({
            model: "gpt-5.1",
            messages: [
                { role: "system", content: "You are a reporting assistant." },
                { role: "user", content: reportPrompt }
            ]
        });

        let reportText = reportResult.choices[0].message.content;

        // Post-process: Remove markdown code block wrappers if present
        reportText = reportText.replace(/```(markdown|html)?/gi, '');
        // Also remove standalone "html" line if it appears on its own line
        reportText = reportText.replace(/^\s*html\s*$/gmi, '');
        reportText = reportText.trim();

        // Save report
        const outputFile = path.join(config.paths.reportsDir, `intraday_report_${todayStr}.md`);
        fs.writeFileSync(outputFile, reportText);

        // Generate companion _meta.json for email sender
        const meta = {
            titleLine: `Intraday Status - ${todayStr} (${reportTimeStr})`,
            generatedTs: new Date().toLocaleString('en-US', { timeZone: TIME_ZONE }),
            dateRange: todayStr,
            reportPath: outputFile,
            callsToday: metrics.totalCalls.toLocaleString(),
            todaySuccessRate: `${metrics.successRate}%`,
            callsInPeriod: metrics.totalCalls.toLocaleString(),
            periodSuccessRate: `${metrics.successRate}%`
        };

        const metaPath = outputFile.replace('.md', '_meta.json');
        fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));

        console.log(`\n=== Intraday Report Complete ===`);
        console.log(`Saved to: ${outputFile}`);
        console.log(`Metadata saved to: ${metaPath}`);

    } catch (error) {
        console.error('Error generating intraday report:', error);
    }
}

generateIntradayReport();

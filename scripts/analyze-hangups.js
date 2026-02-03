/**
 * Analyze Hangups - Generic script for any client
 *
 * Usage: node analyze-hangups.js --client=bathfitter --start=2025-11-01 --end=2025-11-25 [--limit=50] [--force]
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const OpenAI = require('openai');
const { format, parse } = require('date-fns');
const { toZonedTime } = require('date-fns-tz');
const { loadClientConfig } = require('../core/config-loader');
const { loadAllEnrichments } = require('../core/lib/store_enrichment');
const { classifyCall } = require('../core/lib/classify_call');

// Parse command line arguments
const args = process.argv.slice(2);
const clientArg = args.find(arg => arg.startsWith('--client='));
const startArg = args.find(arg => arg.startsWith('--start='));
const endArg = args.find(arg => arg.startsWith('--end='));
const limitArg = args.find(arg => arg.startsWith('--limit='));
const forceArg = args.find(arg => arg === '--force');

if (!clientArg) {
    console.error('Error: --client argument is required');
    console.error('Usage: node analyze-hangups.js --client=<clientname> --start=2025-11-01 --end=2025-11-25 [--limit=50] [--force]');
    process.exit(1);
}

if (!startArg || !endArg) {
    console.error('Error: --start and --end arguments are required');
    console.error('Usage: node analyze-hangups.js --client=<clientname> --start=2025-11-01 --end=2025-11-25 [--limit=50] [--force]');
    process.exit(1);
}

const clientName = clientArg.split('=')[1];
const startDate = startArg.split('=')[1];
const endDate = endArg.split('=')[1];
const limit = limitArg ? parseInt(limitArg.split('=')[1]) : 50;
const forceRefresh = !!forceArg;

// Load client configuration
const config = loadClientConfig(clientName);
const TIME_ZONE = config.client.timezone || 'America/New_York';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

console.log(`=== Analyzing hangups for ${config.client.name} ===`);
console.log(`AI Assistant: ${config.client.aiAssistantName}`);
console.log(`Timezone: ${TIME_ZONE}`);
console.log(`Date range: ${startDate} to ${endDate}`);
console.log(`Analysis limit: ${limit} calls`);
console.log(`Force refresh: ${forceRefresh}`);

if (!OPENAI_API_KEY) {
  console.error('Error: OPENAI_API_KEY environment variable is not set.');
  process.exit(1);
}

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// Helper: Load existing OpenAI analyses
function loadExistingAnalyses() {
  const analysisMap = new Map();

  if (!fs.existsSync(config.paths.openaiAnalysisDir)) {
    return analysisMap;
  }

  const files = fs.readdirSync(config.paths.openaiAnalysisDir).filter(f => f.endsWith('.json'));

  files.forEach(file => {
    try {
      const filePath = path.join(config.paths.openaiAnalysisDir, file);
      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));

      if (Array.isArray(data)) {
        data.forEach(item => {
          if (item.callId && item.analysis) {
            analysisMap.set(item.callId, item);
          }
        });
      }
    } catch (error) {
      console.warn(`Warning: Could not load ${file}: ${error.message}`);
    }
  });

  return analysisMap;
}

// Helper: Save OpenAI analyses
function saveAnalyses(analyses, dateRange) {
  const filename = `hangup_analysis_${dateRange}.json`;
  const filePath = path.join(config.paths.openaiAnalysisDir, filename);

  fs.writeFileSync(filePath, JSON.stringify(analyses, null, 2));
  console.log(`Saved ${analyses.length} analyses to ${filePath}`);
  return filePath;
}

// Helper: Count call frequency for a phone number
function countCallFrequency(phoneNumber, allCalls) {
  return allCalls.filter(c => c.customer?.number === phoneNumber).length;
}

// Helper: Categorize non-success calls into True Hangups vs Spam/Non-Responsive
function categorizeNonSuccessCalls(calls, geminiEnrichments) {
  const trueHangups = [];
  const spamNonResponsive = [];

  calls.forEach(call => {
    // 1. Try to get existing enrichment
    let classification = null;
    const enrichment = geminiEnrichments.get(call.id);

    if (enrichment && enrichment.classification) {
      classification = enrichment.classification;
    } else {
      // 2. Fallback: Use local classification if not enriched
      const localResult = classifyCall(call);
      if (!localResult.needs_analysis) {
        classification = localResult;
      } else {
        // Can't classify - skip this call
        return;
      }
    }

    const category = classification.category?.toLowerCase() || '';

    // Calculate duration in seconds from call timestamps
    let durationSeconds = 0;
    if (call.startedAt && call.endedAt) {
      durationSeconds = Math.floor((new Date(call.endedAt) - new Date(call.startedAt)) / 1000);
    }

    // UNIFIED TAXONOMY FILTERING:
    // EXCLUDE from true hangup analysis (successful outcomes):
    // - booking-completed: Successfully booked appointment
    // - booking-transferred: Booking started, then transferred to human
    // - transferred: Transferred without booking attempt
    // - spam: Robocalls, wrong numbers, very short calls
    //
    // INCLUDE in true hangup analysis (valuable leads we lost):
    // - booking-abandoned: Started booking, customer hung up (HIGH VALUE LEAD)
    // - hangup: Customer hung up without starting booking

    if (category === 'booking-completed' ||
        category === 'booking-transferred' ||
        category === 'transferred' ||
        category === 'spam') {
      return;  // Not a true hangup
    }

    // Legacy support: Also exclude old category names
    if (category === 'booking-success' ||
        category === 'transfer' ||
        category === 'existinginstallation') {
      return;
    }

    // Safety net check: Definitive transfer check (in case enrichment missed it)
    if (call.endedReason === 'assistant-forwarded-call') {
      return;
    }

    // Safety net check: Definitive booking check (in case enrichment missed it)
    if (call.analysis?.artifact?.structuredOutputs) {
      const appointmentBooked = Object.values(call.analysis.artifact.structuredOutputs)
        .find(output => output.name === 'Appointment Booked');

      if (appointmentBooked?.result === true) {
        return;
      }
    }

    // Categorize as SPAM/NON-RESPONSIVE if:
    // - Explicitly tagged as spam
    // - Short abandoned (< 5 seconds)
    // - Other category with very short duration (< 10 seconds)
    if (category === 'spam' ||
      category === 'short-abandoned' ||
      durationSeconds < 5 ||
      (category === 'other' && durationSeconds < 10)) {

      const subType = category === 'spam' ? 'Spam' :
        durationSeconds < 5 ? 'Short-Abandoned (<5s)' : 'No Response';

      spamNonResponsive.push({
        ...call,
        hangupType: 'spam-non-responsive',
        subType: subType
      });
    } else {
      // TRUE HANGUP - Customer engaged but didn't complete booking/transfer
      trueHangups.push({
        ...call,
        hangupType: 'true-hangup'
      });
    }
  });

  return { trueHangups, spamNonResponsive };
}

// Main analysis function
async function analyzeHangups() {
  try {
    console.log('\n=== Hangup Analysis with GPT ===');

    // Load all calls from date range
    const start = parse(startDate, 'yyyy-MM-dd', new Date());
    const end = parse(endDate, 'yyyy-MM-dd', new Date());

    let allCalls = [];
    let currentDate = new Date(start);

    while (currentDate <= end) {
      const dateStr = format(currentDate, 'yyyy-MM-dd');
      const rawFile = path.join(config.paths.rawDir, `vapi_calls_${dateStr}.json`);

      if (fs.existsSync(rawFile)) {
        const calls = JSON.parse(fs.readFileSync(rawFile, 'utf-8'));
        allCalls = allCalls.concat(calls);
      }

      currentDate.setDate(currentDate.getDate() + 1);
    }

    console.log(`Total calls loaded: ${allCalls.length}`);

    // Load enrichments
    const geminiEnrichments = loadAllEnrichments(config.paths.enrichedDir);
    console.log(`Loaded ${geminiEnrichments.size} enrichments`);

    // Categorize non-success calls into True Hangups vs Spam/Non-Responsive
    const { trueHangups, spamNonResponsive } = categorizeNonSuccessCalls(allCalls, geminiEnrichments);
    console.log(`\nCall Categorization:`);
    console.log(`  True Hangups: ${trueHangups.length}`);
    console.log(`  Spam/Non-Responsive: ${spamNonResponsive.length}`);
    console.log(`  Total non-success: ${trueHangups.length + spamNonResponsive.length}`);

    // Create maps for quick call data lookup in report generation
    const allNonSuccessCalls = [...trueHangups, ...spamNonResponsive];
    const callsMap = new Map(allNonSuccessCalls.map(call => [call.id, call]));

    // Debug: Show breakdown of all calls
    const breakdown = {};
    allCalls.forEach(call => {
      const enrichment = geminiEnrichments.get(call.id);
      const category = enrichment?.classification?.category || 'No enrichment';
      const transferReason = enrichment?.classification?.transferReason;
      const spamType = enrichment?.classification?.spamType;
      const hangupType = enrichment?.classification?.hangupType;

      let key = category;
      if (transferReason) {
        key += ` (${transferReason})`;
      } else if (spamType) {
        key += ` (${spamType})`;
      } else if (hangupType) {
        key += ` (${hangupType})`;
      }

      breakdown[key] = (breakdown[key] || 0) + 1;
    });
    console.log('\nCall breakdown by unified taxonomy:');
    Object.entries(breakdown).sort((a, b) => b[1] - a[1]).forEach(([key, count]) => {
      console.log(`  ${key}: ${count}`);
    });

    if (trueHangups.length === 0) {
      console.log('No true hangup calls to analyze.');
      return;
    }

    // Load existing OpenAI analyses
    const existingAnalyses = loadExistingAnalyses();
    console.log(`Loaded ${existingAnalyses.size} existing OpenAI analyses`);

    // Filter TRUE HANGUP calls that need analysis (don't analyze spam/non-responsive)
    let callsToAnalyze = trueHangups;
    if (!forceRefresh) {
      callsToAnalyze = trueHangups.filter(call => !existingAnalyses.has(call.id));
      console.log(`New true hangup calls to analyze: ${callsToAnalyze.length}`);
    }

    // Apply limit
    if (callsToAnalyze.length > limit) {
      console.log(`Limiting analysis to ${limit} calls (use --limit=N to change)`);
      callsToAnalyze = callsToAnalyze.slice(0, limit);
    }

    // Analyze each call with GPT
    const newAnalyses = [];

    const aiName = config.client.aiAssistantName;
    const businessName = config.client.name;
    const businessDesc = config.client.description || '';

    // Build services list
    let servicesList = '';
    if (config.client.services && config.client.services.length > 0) {
      servicesList = config.client.services.map(s => `- ${s}`).join('\n');
    }

    // Build call purposes list
    let callPurposesList = '';
    if (config.client.callPurposes && config.client.callPurposes.length > 0) {
      callPurposesList = config.client.callPurposes.map(p => `- ${p}`).join('\n');
    }

    for (let i = 0; i < callsToAnalyze.length; i++) {
      const call = callsToAnalyze[i];
      console.log(`\nAnalyzing call ${i + 1}/${callsToAnalyze.length}: ${call.id}`);

      // Get enrichment
      const geminiEnrichment = geminiEnrichments.get(call.id);
      const callFrequency = countCallFrequency(call.customer?.number, allCalls);

      // Prepare call data
      const callData = {
        id: call.id,
        customer: {
          name: call.customer?.name || 'Unknown',
          number: call.customer?.number || 'Unknown',
          totalCallsFromNumber: callFrequency
        },
        callMetadata: {
          date: format(toZonedTime(new Date(call.createdAt), TIME_ZONE), 'yyyy-MM-dd'),
          time: format(toZonedTime(new Date(call.createdAt), TIME_ZONE), 'HH:mm:ss'),
          duration: call.duration || 0,
          endedReason: call.endedReason || 'unknown'
        },
        conversation: {
          summary: call.summary || 'No summary available',
          transcript: call.transcript || 'No transcript available',
          messages: call.messages || []
        },
        geminiAnalysis: geminiEnrichment ? {
          category: geminiEnrichment.classification?.category || 'unknown',
          bookingStatus: geminiEnrichment.classification?.bookingStatus || 'N/A',
          transferReason: geminiEnrichment.classification?.transferReason || 'N/A'
        } : null
      };

      try {
        const completion = await openai.chat.completions.create({
          model: "gpt-4o-mini",
          messages: [
            {
              role: "system",
              content: `You are an expert call quality analyst for an AI voice assistant named ${aiName} that handles inbound calls for ${businessName}. ${businessDesc}. Your job is to analyze customer hangup calls to identify qualified leads, understand why customers hung up, and provide actionable feedback for the human call center team.`
            },
            {
              role: "user",
              content: `You are analyzing a call classified as a TRUE HANGUP by our rule-based system.

**FIRST: VALIDATE THE CLASSIFICATION**
Review the geminiAnalysis classification and call metadata. If this call is ACTUALLY:
- A successful booking (${aiName} confirmed appointment with date/time/address)
- A transferred call (endedReason: "assistant-forwarded-call")
- Spam or wrong number

Then respond with:
{
  "error": "MISCLASSIFIED",
  "actualCategory": "booking-success|transferred|spam",
  "evidence": "Brief explanation why this is not a hangup"
}

**ONLY IF THIS IS A VALID HANGUP, PROCEED WITH ANALYSIS:**

**BUSINESS CONTEXT:**
${businessName} specializes in:
${servicesList}

${aiName} (AI assistant) handles inbound calls to:
${callPurposesList}

**Call Data:**
${JSON.stringify(callData, null, 2)}

**Analysis Questions:**
1. Was this a qualified lead? (Someone genuinely interested in ${businessName} services)
2. Why did the customer hang up? What was the root cause?
3. What should the human call center team DO with this lead? What specific actions should they take when calling back?
4. Should we call this customer back? What's the likelihood they would convert?

**Respond in this exact JSON format:**
{
  "isQualifiedLead": "Yes|No|Maybe",
  "qualificationJustification": "1-2 sentence explanation",
  "qualificationEvidence": ["quote or evidence 1", "quote or evidence 2"],
  "hangupReason": "Primary reason customer hung up",
  "humanActions": ["specific action call center should take 1", "specific action call center should take 2", "specific action call center should take 3"],
  "callbackPriority": "High|Medium|Low|None",
  "callbackReasoning": "Why this priority level",
  "overallInsight": "1-2 sentence summary of key takeaway"
}`
            }
          ],
          response_format: { type: "json_object" },
          temperature: 0.7
        });

        const analysis = JSON.parse(completion.choices[0].message.content);

        newAnalyses.push({
          callId: call.id,
          createdAt: call.createdAt,
          customerNumber: call.customer?.number,
          analyzedAt: new Date().toISOString(),
          model: "gpt-4o-mini",
          analysis: analysis
        });

        console.log(`  ✓ Qualified: ${analysis.isQualifiedLead} | Priority: ${analysis.callbackPriority} | Reason: ${analysis.hangupReason.substring(0, 50)}...`);

        // Rate limiting (avoid hitting API limits)
        if (i < callsToAnalyze.length - 1) {
          await new Promise(resolve => setTimeout(resolve, 1000)); // 1 second delay
        }

      } catch (error) {
        console.error(`  ✗ Error analyzing call: ${error.message}`);
      }
    }

    console.log(`\nCompleted ${newAnalyses.length} new analyses`);

    // Save new analyses
    if (newAnalyses.length > 0) {
      const dateRange = `${startDate}_to_${endDate}`;
      saveAnalyses(newAnalyses, dateRange);
    }

    // Combine all analyses (existing + new)
    const allAnalyses = Array.from(existingAnalyses.values())
      .filter(a => {
        const callDate = new Date(a.createdAt);
        return callDate >= start && callDate <= end;
      })
      .concat(newAnalyses);

    console.log(`\nTotal analyses for report: ${allAnalyses.length}`);

    // Dataset-level analysis
    if (allAnalyses.length > 0) {
      console.log('\nPerforming dataset-level pattern analysis...');

      const datasetCompletion = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content: `You are a data analysis expert specializing in customer experience for ${businessName}. Analyze call patterns to identify opportunities to improve ${aiName} (the AI assistant) and the overall customer journey.`
          },
          {
            role: "user",
            content: `Analyze patterns across these ${allAnalyses.length} ${businessName} hangup call analyses:

${JSON.stringify(allAnalyses.map(a => ({
              qualified: a.analysis.isQualifiedLead,
              hangupReason: a.analysis.hangupReason,
              improvements: a.analysis.improvementSuggestions || a.analysis.humanActions,
              priority: a.analysis.callbackPriority
            })), null, 2)}

**BUSINESS CONTEXT:**
${businessName} specializes in:
${servicesList}

${aiName} (AI assistant) handles inbound calls to:
${callPurposesList}

**Provide:**
1. Top 5 most common hangup reasons (with counts/percentages)
2. Systemic patterns in ${aiName}'s performance - where does ${aiName} fail to address customer questions or concerns?
3. Top 3 training recommendations for ${aiName} - how can ${aiName} better handle customer calls?
4. High-value callback segments (types of calls most worth following up) - which leads have highest conversion potential?

Return as structured JSON with these exact keys: commonHangupReasons, systemicPatterns, trainingRecommendations, callbackSegments`
          }
        ],
        response_format: { type: "json_object" },
        temperature: 0.7
      });

      const datasetInsights = JSON.parse(datasetCompletion.choices[0].message.content);

      // Generate markdown report
      console.log('\nGenerating markdown report...');
      await generateReport(allAnalyses, datasetInsights, callsMap, allCalls, geminiEnrichments, { trueHangups, spamNonResponsive });
    }

    console.log('\n=== Analysis Complete ===');

  } catch (error) {
    console.error(`Fatal error: ${error.message}`);
    console.error(error.stack);
    process.exit(1);
  }
}

// Generate markdown report
async function generateReport(analyses, datasetInsights, callsMap, allCalls, geminiEnrichments, categorizedData) {
  const aiName = config.client.aiAssistantName;
  const reportDate = format(new Date(), 'EEE, MMM dd, yyyy');
  const reportPath = path.join(config.paths.reportsDir, `hangup_analysis_${startDate}_to_${endDate}.md`);

  // Calculate stats
  const stats = {
    total: analyses.length,
    qualified: analyses.filter(a => a.analysis.isQualifiedLead === 'Yes').length,
    maybe: analyses.filter(a => a.analysis.isQualifiedLead === 'Maybe').length,
    notQualified: analyses.filter(a => a.analysis.isQualifiedLead === 'No').length,
    highPriority: analyses.filter(a => a.analysis.callbackPriority === 'High').length,
    mediumPriority: analyses.filter(a => a.analysis.callbackPriority === 'Medium').length,
    lowPriority: analyses.filter(a => a.analysis.callbackPriority === 'Low').length,
    noPriority: analyses.filter(a => a.analysis.callbackPriority === 'None').length
  };

  // Calculate date range details
  const start = parse(startDate, 'yyyy-MM-dd', new Date());
  const end = parse(endDate, 'yyyy-MM-dd', new Date());
  const startFormatted = format(start, 'EEE M/d');
  const endFormatted = format(end, 'EEE M/d');
  const daysDiff = Math.round((end - start) / (1000 * 60 * 60 * 24)) + 1;

  let report = `# ${aiName} Hangup Call Analysis Report
**${config.client.name}**
**Generated:** ${reportDate}
**Date Range:** ${startFormatted} to ${endFormatted} (Total of ${daysDiff} days)
**Model:** GPT-4o-mini

---

## Executive Summary

**Total Calls in Period:** ${allCalls.length}
**Calls Without Booking or Transfer:** ${categorizedData.trueHangups.length + categorizedData.spamNonResponsive.length}

### Call Breakdown
- **True Hangups:** ${categorizedData.trueHangups.length} (${(categorizedData.trueHangups.length / (categorizedData.trueHangups.length + categorizedData.spamNonResponsive.length) * 100).toFixed(1)}%)
  - Customers who hung up during conversation
  - **Analyzed with GPT:** ${stats.total} calls
- **Spam/Non-Responsive:** ${categorizedData.spamNonResponsive.length} (${(categorizedData.spamNonResponsive.length / (categorizedData.trueHangups.length + categorizedData.spamNonResponsive.length) * 100).toFixed(1)}%)
  - Robocalls, short-abandoned calls (<5s), non-engaged callers
  - **Not analyzed** (no actionable insights)

### Lead Qualification (True Hangups Only)
- **Qualified Leads:** ${stats.qualified} (${((stats.qualified / stats.total) * 100).toFixed(1)}%)
- **Maybe Qualified:** ${stats.maybe} (${((stats.maybe / stats.total) * 100).toFixed(1)}%)
- **Not Qualified:** ${stats.notQualified} (${((stats.notQualified / stats.total) * 100).toFixed(1)}%)

### Callback Priority Distribution (True Hangups Only)
- **High Priority:** ${stats.highPriority} calls
- **Medium Priority:** ${stats.mediumPriority} calls
- **Low Priority:** ${stats.lowPriority} calls
- **No Callback Needed:** ${stats.noPriority} calls

---

## Dataset Insights

### Common Hangup Reasons
${JSON.stringify(datasetInsights.commonHangupReasons || [], null, 2)}

### Systemic Patterns in ${aiName}'s Performance
${JSON.stringify(datasetInsights.systemicPatterns || [], null, 2)}

### Training Recommendations for ${aiName}
${JSON.stringify(datasetInsights.trainingRecommendations || [], null, 2)}

### High-Value Callback Segments
${JSON.stringify(datasetInsights.callbackSegments || [], null, 2)}

---

## Individual Call Analyses

`;

  // Add individual call details
  const sortedAnalyses = analyses.sort((a, b) => {
    const priorityOrder = { 'High': 0, 'Medium': 1, 'Low': 2, 'None': 3 };
    return priorityOrder[a.analysis.callbackPriority] - priorityOrder[b.analysis.callbackPriority];
  });

  for (const analysis of sortedAnalyses) {
    const call = callsMap.get(analysis.callId);
    if (!call) continue;

    const callDate = format(toZonedTime(new Date(call.createdAt), TIME_ZONE), 'MMM d, yyyy HH:mm');

    report += `### Call: ${analysis.customerNumber || 'Unknown'} (${callDate})\n\n`;
    report += `**Qualified Lead:** ${analysis.analysis.isQualifiedLead}\n`;
    report += `**Callback Priority:** ${analysis.analysis.callbackPriority}\n`;
    report += `**Hangup Reason:** ${analysis.analysis.hangupReason}\n\n`;
    report += `**Justification:** ${analysis.analysis.qualificationJustification}\n\n`;
    report += `**Evidence:**\n`;
    if (analysis.analysis.qualificationEvidence && Array.isArray(analysis.analysis.qualificationEvidence)) {
      analysis.analysis.qualificationEvidence.forEach(evidence => {
        report += `- ${evidence}\n`;
      });
    }
    report += `\n**Human Actions:**\n`;
    if (analysis.analysis.humanActions && Array.isArray(analysis.analysis.humanActions)) {
      analysis.analysis.humanActions.forEach(action => {
        report += `- ${action}\n`;
      });
    }
    report += `\n**Callback Reasoning:** ${analysis.analysis.callbackReasoning}\n`;
    report += `\n**Overall Insight:** ${analysis.analysis.overallInsight}\n\n`;
    report += `---\n\n`;
  }

  // Save report
  fs.writeFileSync(reportPath, report);
  console.log(`Report saved to: ${reportPath}`);
}

// Run analysis
analyzeHangups();

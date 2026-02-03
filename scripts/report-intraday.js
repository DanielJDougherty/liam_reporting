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

const TRANSFER_TOOL_NAMES = new Set(['intent_transfer', 'transfer_intent', 'transferCall']);

function getCallDuration(call) {
    let duration = call.duration || 0;
    if (!duration && call.startedAt && call.endedAt) {
        const start = new Date(call.startedAt);
        const end = new Date(call.endedAt);
        duration = (end - start) / 1000; // Convert ms to seconds
    }
    return duration;
}

function getTransferIntent(call) {
    if (Array.isArray(call.toolCalls)) {
        const tool = call.toolCalls.find(t => TRANSFER_TOOL_NAMES.has(t.function?.name));
        if (tool?.function?.arguments) {
            try {
                const args = JSON.parse(tool.function.arguments);
                return args.destination || args.intent || args.department || args.queue || null;
            } catch (e) {}
        }
    }

    if (Array.isArray(call.messages)) {
        for (const msg of call.messages) {
            if (!msg.toolCalls) continue;
            const tool = msg.toolCalls.find(t => TRANSFER_TOOL_NAMES.has(t.function?.name));
            if (tool?.function?.arguments) {
                try {
                    const args = JSON.parse(tool.function.arguments);
                    return args.destination || args.intent || args.department || args.queue || null;
                } catch (e) {}
            }
        }
    }

    return null;
}

function percentile(values, pct) {
    if (!values.length) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const rank = Math.ceil((pct / 100) * sorted.length) - 1;
    return sorted[Math.max(0, Math.min(rank, sorted.length - 1))];
}

function computeDurationStats(values) {
    if (!values.length) {
        return { avg: 0, median: 0, p90: 0 };
    }
    const avg = Math.round(values.reduce((sum, v) => sum + v, 0) / values.length);
    const median = percentile(values, 50);
    const p90 = percentile(values, 90);
    return { avg, median, p90 };
}

function computeDurationBuckets(values) {
    const buckets = {
        '0-15s': 0,
        '15-30s': 0,
        '30-60s': 0,
        '60-120s': 0,
        '120s+': 0
    };

    for (const v of values) {
        if (v < 15) buckets['0-15s'] += 1;
        else if (v < 30) buckets['15-30s'] += 1;
        else if (v < 60) buckets['30-60s'] += 1;
        else if (v < 120) buckets['60-120s'] += 1;
        else buckets['120s+'] += 1;
    }

    return buckets;
}

function formatDuration(seconds) {
    const minutes = Math.floor(seconds / 60);
    const secs = Math.round(seconds % 60);
    return `${minutes}:${secs.toString().padStart(2, '0')}`;
}

function hasCustomerSpeech(call) {
    if (Array.isArray(call.messages)) {
        return call.messages.some(msg =>
            msg.role === 'user' &&
            typeof msg.message === 'string' &&
            msg.message.trim().match(/\w+/)
        );
    }
    return false;
}

function isSpamLikelyShortNoSpeech(call, durationSeconds) {
    return durationSeconds > 0 && durationSeconds <= 10 && !hasCustomerSpeech(call);
}

function cleanSummaryText(summary) {
    if (!summary) return 'No summary';
    let cleaned = summary.replace(/\s+/g, ' ').trim();
    // Strip all known verbose prefixes (including markdown bold variants)
    cleaned = cleaned.replace(/^\*{0,2}here'?s a summary[^:]*:\*{0,2}\s*/i, '');
    cleaned = cleaned.replace(/^\*{0,2}summary of (?:the )?interaction:?\*{0,2}\s*/i, '');
    cleaned = cleaned.replace(/^\*{0,2}summary:?\*{0,2}\s*/i, '');
    // Remove leading ** if leftover
    cleaned = cleaned.replace(/^\*{1,2}\s*/, '');
    if (cleaned.length <= 100) return cleaned || 'No summary';
    // Truncate at word boundary + ellipsis
    const truncated = cleaned.slice(0, 100).replace(/\s+\S*$/, '');
    return (truncated || cleaned.slice(0, 100)) + '...';
}

function categoryEmoji(category) {
    switch ((category || '').toLowerCase()) {
        case 'booking-completed': return '✓ booked';
        case 'booking-transferred': return '→ book-xfer';
        case 'booking-abandoned': return '⚠ book-abandoned';
        case 'transferred': return '→ transfer';
        case 'spam': return '✗ spam';
        case 'hangup': return '↩ hangup';
        default: return category || 'unknown';
    }
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

            const duration = getCallDuration(call);
            const transferIntent = getTransferIntent(call);
            const routed = call.endedReason === 'assistant-forwarded-call';
            const transferAttempted = Boolean(transferIntent);
            const intentIdentified = Boolean(transferIntent || transferReason);
            const notRouted = !transferAttempted && (call.endedReason === 'customer-ended-call' || call.endedReason === 'assistant-ended-call');
            const hangupBeforeRoute = transferAttempted && !routed && call.endedReason === 'customer-ended-call';
            const spamLikely = isSpamLikelyShortNoSpeech(call, duration);

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
                endedReason: call.endedReason,
                transferIntent: transferIntent,
                routed: routed,
                transferAttempted: transferAttempted,
                intentIdentified: intentIdentified,
                notRouted: notRouted,
                hangupBeforeRoute: hangupBeforeRoute,
                spamLikely: spamLikely
            };
        });

        // 5. Calculate routing metrics
        const totalCalls = processedCalls.length;
        const spamCalls = processedCalls.filter(c => c.category?.toLowerCase() === 'spam').length;
        const spamLikelyCalls = processedCalls.filter(c => c.spamLikely).length;
        const intentIdentified = processedCalls.filter(c => c.intentIdentified).length;
        const transferAttempted = processedCalls.filter(c => c.transferAttempted).length;
        const routedCalls = processedCalls.filter(c => c.routed).length;
        const notRoutedCalls = processedCalls.filter(c => c.notRouted).length;
        const hangupBeforeRoute = processedCalls.filter(c => c.hangupBeforeRoute).length;

        const notRoutedDurations = processedCalls.filter(c => c.notRouted && c.duration > 0).map(c => c.duration);
        const routedDurations = processedCalls.filter(c => c.routed && c.duration > 0).map(c => c.duration);

        const notRoutedStats = computeDurationStats(notRoutedDurations);
        const routedStats = computeDurationStats(routedDurations);
        const notRoutedBuckets = computeDurationBuckets(notRoutedDurations);

        const routingRate = totalCalls > 0 ? ((routedCalls / totalCalls) * 100).toFixed(1) : '0.0';
        const transferAttemptRate = totalCalls > 0 ? ((transferAttempted / totalCalls) * 100).toFixed(1) : '0.0';
        const transferFailureRate = transferAttempted > 0
            ? (((transferAttempted - routedCalls) / transferAttempted) * 100).toFixed(1)
            : '0.0';
        const spamRate = totalCalls > 0 ? ((spamCalls / totalCalls) * 100).toFixed(1) : '0.0';
        const spamLikelyRate = totalCalls > 0 ? ((spamLikelyCalls / totalCalls) * 100).toFixed(1) : '0.0';

        // After-hours calls (outside business hours)
        const businessHours = config.client.businessHours || { start: 8, end: 17, days: [1, 2, 3, 4, 5] };
        const afterHoursCalls = processedCalls.filter(c => {
            if (!c.createdAt) return false;
            const callTime = toZonedTime(new Date(c.createdAt), TIME_ZONE);
            const hour = callTime.getHours();
            const day = callTime.getDay();
            return hour < businessHours.start || hour >= businessHours.end || !businessHours.days.includes(day);
        }).length;

        // Transfer reasons (routed only)
        const transferReasons = {};
        for (const call of processedCalls) {
            if (!call.routed) continue;
            const reasonRaw = call.transferReason || call.transferIntent || 'unspecified';
            const reason = String(reasonRaw).trim().toLowerCase() || 'unspecified';
            transferReasons[reason] = (transferReasons[reason] || 0) + 1;
        }

        const metrics = {
            totalCalls,
            spamCalls,
            intentIdentified,
            transferAttempted,
            routedCalls,
            notRoutedCalls,
            hangupBeforeRoute,
            routingRate,
            transferAttemptRate,
            transferFailureRate,
            spamRate,
            spamLikelyCalls,
            spamLikelyRate,
            afterHoursCalls,
            notRoutedStats,
            notRoutedBuckets,
            routedStats,
            transferReasons
        };

        console.log(`Metrics - Total: ${metrics.totalCalls}, Spam: ${metrics.spamCalls}, Intent: ${metrics.intentIdentified}, Attempted: ${metrics.transferAttempted}, Routed: ${metrics.routedCalls}, Not Routed: ${metrics.notRoutedCalls}, Hangup Before Route: ${metrics.hangupBeforeRoute}, After-Hours: ${metrics.afterHoursCalls}`);

        // 6. Generate Report with detailed metrics
        // 6. Generate Report with detailed metrics
        const aiName = config.client.aiAssistantName;
        const businessName = config.client.name;
        const businessDesc = config.client.description || '';

        // Build call purposes list
        let callPurposesList = '';
        if (config.client.callPurposes && config.client.callPurposes.length > 0) {
            callPurposesList = config.client.callPurposes.map(p => `- ${p}`).join('\n');
        }

        const notRoutedBucketRows = Object.entries(metrics.notRoutedBuckets)
            .map(([bucket, count]) => `| ${bucket} | ${count} |`)
            .join('\n');

        const routedTotal = metrics.routedCalls;
        const transferReasonRows = Object.entries(metrics.transferReasons).length > 0
            ? Object.entries(metrics.transferReasons).map(([reason, count]) => {
                const pct = routedTotal > 0 ? ((count / routedTotal) * 100).toFixed(1) : '0.0';
                return `| ${reason} | ${count} | ${pct}% |`;
            }).join('\n')
            : '| No routed calls | 0 | 0% |';

        const topNotRouted = [...processedCalls]
            .filter(c => c.notRouted)
            .sort((a, b) => (b.duration || 0) - (a.duration || 0))
            .slice(0, 10)
            .map(call => {
                const timeStr = call.createdAt
                    ? format(toZonedTime(new Date(call.createdAt), TIME_ZONE), 'h:mm a')
                    : 'N/A';
                const summary = cleanSummaryText(call.summary || '');
                return `| ${timeStr} | ${formatDuration(call.duration || 0)} | ${call.endedReason || 'unknown'} | ${summary} |`;
            })
            .join('\n');

        const reportPrompt = `
You are writing an **Intraday Status Report** for the ${businessName} executive team.

**BUSINESS CONTEXT:**
${businessName} is ${businessDesc}. ${aiName} (AI assistant) routes inbound calls to the correct department.
${callPurposesList}

**Context**:
- Date: ${todayStr}
- Time: ${reportTimeStr} ${TIME_ZONE.split('/')[1]}
- Total Calls So Far: ${metrics.totalCalls}

**Metrics**:
- Total Calls: ${metrics.totalCalls}
- Spam Calls: ${metrics.spamCalls} (${metrics.spamRate}%)
- Spam Likely (short/no speech): ${metrics.spamLikelyCalls} (${metrics.spamLikelyRate}%)
- Intent Identified: ${metrics.intentIdentified}
- Transfer Attempted: ${metrics.transferAttempted} (${metrics.transferAttemptRate}%)
- Routed: ${metrics.routedCalls} (${metrics.routingRate}%)
- Transfer Failure Rate: ${metrics.transferFailureRate}%
- Not Routed: ${metrics.notRoutedCalls}
- Hangup Before Route: ${metrics.hangupBeforeRoute}
- After-Hours Calls: ${metrics.afterHoursCalls}
- Routed Duration (Avg/Median): ${formatDuration(metrics.routedStats.avg)} / ${formatDuration(metrics.routedStats.median)}
- Not-Routed Duration (Avg/Median/P90): ${formatDuration(metrics.notRoutedStats.avg)} / ${formatDuration(metrics.notRoutedStats.median)} / ${formatDuration(metrics.notRoutedStats.p90)}

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
(3 concise paragraphs covering routing performance, transfer efficiency, and notable patterns)

## Today's Routing Performance

| Metric | Count | % |
|--------|-------|---|
| Total Calls | ${metrics.totalCalls} | 100% |
| Spam Calls | ${metrics.spamCalls} | ${metrics.spamRate}% |
| Spam Likely (short/no speech) | ${metrics.spamLikelyCalls} | ${metrics.spamLikelyRate}% |
| Intent Identified | ${metrics.intentIdentified} | - |
| Transfer Attempted | ${metrics.transferAttempted} | ${metrics.transferAttemptRate}% |
| Routed | ${metrics.routedCalls} | ${metrics.routingRate}% |
| Not Routed | ${metrics.notRoutedCalls} | - |
| Hangup Before Route | ${metrics.hangupBeforeRoute} | - |
| After-Hours Calls | ${metrics.afterHoursCalls} | - |

## Duration Quality
- **Routed Duration (Avg/Median):** ${formatDuration(metrics.routedStats.avg)} / ${formatDuration(metrics.routedStats.median)}
- **Not-Routed Duration (Avg/Median/P90):** ${formatDuration(metrics.notRoutedStats.avg)} / ${formatDuration(metrics.notRoutedStats.median)} / ${formatDuration(metrics.notRoutedStats.p90)}

### Not-Routed Duration Histogram
| Bucket | Count |
|--------|-------|
${notRoutedBucketRows || '| No not-routed calls | 0 |'}

## Transfer Breakdown by Reason (Routed Only)
| Reason | Count | % of Routed |
|--------|-------|-------------|
${transferReasonRows}

## Top 10 Not-Routed Call Summaries
| Time | Duration | Ended Reason | Summary |
|------|----------|--------------|---------|
${topNotRouted || '| No not-routed calls | - | - | - |'}

## Call Log

Create an HTML table with these columns:
- Time (${TIME_ZONE.split('/')[1]})
- Caller #
- Email
- Duration
- Category
- Status/Type (show transferReason for routed calls, spamType for spam, hangupType for hangups, and "N/A" otherwise)
- Summary

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

        const callLogRows = processedCalls.map(call => {
            const timeStr = call.createdAt
                ? format(toZonedTime(new Date(call.createdAt), TIME_ZONE), 'h:mm a')
                : 'N/A';
            const statusType = call.routed
                ? (call.transferReason || call.transferIntent || 'N/A')
                : (call.category?.toLowerCase() === 'spam'
                    ? (call.spamType || 'N/A')
                    : (call.category?.toLowerCase() === 'hangup'
                        ? (call.hangupType || 'N/A')
                        : 'N/A'));
            const summary = cleanSummaryText(call.summary || '');

            return `<tr>
  <td style="padding: 8px; border: 1px solid #ddd;">${timeStr}</td>
  <td style="padding: 8px; border: 1px solid #ddd;">${call.customerNumber || 'Unknown'}</td>
  <td style="padding: 8px; border: 1px solid #ddd;">${call.email || 'N/A'}</td>
  <td style="padding: 8px; border: 1px solid #ddd;">${formatDuration(call.duration || 0)}</td>
  <td style="padding: 8px; border: 1px solid #ddd;">${categoryEmoji(call.category)}</td>
  <td style="padding: 8px; border: 1px solid #ddd;">${statusType}</td>
  <td style="padding: 8px; border: 1px solid #ddd;">${summary}</td>
</tr>`;
        }).join('\n');

        const callLogTable = `
## Call Log

<table border="1" style="border-collapse: collapse; width: 100%;">
  <tr style="background-color: #f5f5f5;">
    <th style="padding: 8px; border: 1px solid #ddd;">Time (${TIME_ZONE.split('/')[1]})</th>
    <th style="padding: 8px; border: 1px solid #ddd;">Caller #</th>
    <th style="padding: 8px; border: 1px solid #ddd;">Email</th>
    <th style="padding: 8px; border: 1px solid #ddd;">Duration</th>
    <th style="padding: 8px; border: 1px solid #ddd;">Category</th>
    <th style="padding: 8px; border: 1px solid #ddd;">Status/Type</th>
    <th style="padding: 8px; border: 1px solid #ddd;">Summary</th>
  </tr>
  ${callLogRows}
</table>
`;

        reportText = `${reportText}\n\n${callLogTable}`;

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
            todaySuccessRate: `${metrics.routingRate}%`,
            callsInPeriod: metrics.totalCalls.toLocaleString(),
            periodSuccessRate: `${metrics.routingRate}%`
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

/**
 * Weekly Executive Report - Generic script for any client
 *
 * Usage: node report-weekly.js --client=bathfitter [--week=2025-W47]
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { parseISO, getWeek, getYear, startOfWeek, endOfWeek, format, subWeeks } = require('date-fns');
const { toZonedTime } = require('date-fns-tz');
const OpenAI = require('openai');
const { loadClientConfig } = require('../core/config-loader');
const { buildReportPrompt } = require('../core/prompt-builder');

// Import utility libraries
const { generateHeatmap, formatHeatmapAsMarkdown, findPeakHours } = require('../core/lib/generate_heatmap');
const { compareAIvsHuman, formatCostComparisonTable, estimateRevenue, formatRevenueEstimate, calculateROI, formatROI } = require('../core/lib/calculate_roi');
const { generateLeadsReport } = require('../core/lib/export_leads');

// Parse command line arguments
const args = process.argv.slice(2);
const clientArg = args.find(arg => arg.startsWith('--client='));
const weekArg = args.find(arg => arg.startsWith('--week='));

if (!clientArg) {
    console.error('Error: --client argument is required');
    console.error('Usage: node report-weekly.js --client=<clientname> [--week=2025-W47]');
    process.exit(1);
}

const clientName = clientArg.split('=')[1];

// Load client configuration
const config = loadClientConfig(clientName);
const TIME_ZONE = config.client.timezone || 'America/New_York';

console.log(`=== Generating weekly report for ${config.client.name} ===`);
console.log(`AI Assistant: ${config.client.aiAssistantName}`);
console.log(`Timezone: ${TIME_ZONE}`);

// Load all enrichment data
function loadEnrichments() {
    const map = new Map();
    if (fs.existsSync(config.paths.enrichedDir)) {
        const files = fs.readdirSync(config.paths.enrichedDir).filter(f => f.endsWith('.json'));
        for (const file of files) {
            try {
                const content = JSON.parse(fs.readFileSync(path.join(config.paths.enrichedDir, file), 'utf8'));
                if (Array.isArray(content)) {
                    for (const e of content) {
                        if (e && e.callId) map.set(e.callId, e);
                    }
                } else if (typeof content === 'object') {
                    for (const e of Object.values(content)) {
                        if (e && e.callId) map.set(e.callId, e);
                    }
                }
            } catch (err) {
                console.warn(`Could not parse enrichment ${file}`);
            }
        }
    }
    return map;
}

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
        duration = (end - start) / 1000;
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
    if (cleaned.length <= 300) return cleaned || 'No summary';
    // Truncate at word boundary + ellipsis
    const truncated = cleaned.slice(0, 300).replace(/\s+\S*$/, '');
    return (truncated || cleaned.slice(0, 300)) + '...';
}

// Process and enrich calls
function processAndEnrichCalls(calls, enrichmentMap) {
    return calls.map(call => {
        const enrichment = enrichmentMap.get(call.id);

        // Extract email and duration
        const email = extractEmail(call);
        const duration = getCallDuration(call);
        const transferIntent = getTransferIntent(call);
        const spamLikely = isSpamLikelyShortNoSpeech(call, duration);

        // Extract classification
        let category = 'unknown';
        let hangupType = null;
        let transferReason = null;
        let spamType = null;

        if (enrichment && enrichment.classification) {
            const c = enrichment.classification;
            category = (c.category || 'unknown').toLowerCase();
            hangupType = c.hangupType || null;
            transferReason = c.transferReason || null;
            spamType = c.spamType || null;
        }

        const routed = call.endedReason === 'assistant-forwarded-call';
        const transferAttempted = Boolean(transferIntent);
        const intentIdentified = Boolean(transferIntent || transferReason);
        const notRouted = !transferAttempted && (call.endedReason === 'customer-ended-call' || call.endedReason === 'assistant-ended-call');
        const hangupBeforeRoute = transferAttempted && !routed && call.endedReason === 'customer-ended-call';

        return {
            ...call,
            category,
            hangupType,
            transferReason,
            spamType,
            email,
            duration,
            transferIntent,
            routed,
            transferAttempted,
            intentIdentified,
            notRouted,
            hangupBeforeRoute,
            phoneNumber: call.customer?.number || 'Unknown',
            customerName: call.customer?.name || 'Unknown',
            endedReason: call.endedReason,
            summary: call.summary || 'No summary',
            spamLikely: spamLikely
        };
    });
}

// Calculate comprehensive metrics
function calculateMetrics(enrichedCalls) {
    const totalCalls = enrichedCalls.length;

    const spamCalls = enrichedCalls.filter(c => c.category === 'spam').length;
    const spamLikelyCalls = enrichedCalls.filter(c => c.spamLikely).length;
    const intentIdentified = enrichedCalls.filter(c => c.intentIdentified).length;
    const transferAttempted = enrichedCalls.filter(c => c.transferAttempted).length;
    const routedCalls = enrichedCalls.filter(c => c.routed).length;
    const notRoutedCalls = enrichedCalls.filter(c => c.notRouted).length;
    const hangupBeforeRoute = enrichedCalls.filter(c => c.hangupBeforeRoute).length;

    const notRoutedDurations = enrichedCalls.filter(c => c.notRouted && c.duration > 0).map(c => c.duration);
    const routedDurations = enrichedCalls.filter(c => c.routed && c.duration > 0).map(c => c.duration);

    const notRoutedStats = computeDurationStats(notRoutedDurations);
    const routedStats = computeDurationStats(routedDurations);
    const notRoutedBuckets = computeDurationBuckets(notRoutedDurations);

    const totalMinutes = enrichedCalls.reduce((sum, c) => sum + (c.duration || 0), 0) / 60;

    // After-hours calls (outside business hours)
    const businessHours = config.client.businessHours || { start: 8, end: 17, days: [1, 2, 3, 4, 5] };
    const afterHoursCalls = enrichedCalls.filter(c => {
        if (!c.createdAt) return false;
        const callTime = toZonedTime(new Date(c.createdAt), TIME_ZONE);
        const hour = callTime.getHours();
        const day = callTime.getDay();
        const schedule = businessHours.schedule || {};
        const daySchedule = schedule[String(day)] || schedule[day];
        if (daySchedule && typeof daySchedule.start === 'number' && typeof daySchedule.end === 'number') {
            return hour < daySchedule.start || hour >= daySchedule.end;
        }
        if (businessHours.days && !businessHours.days.includes(day)) return true;
        return hour < businessHours.start || hour >= businessHours.end;
    }).length;

    const transferReasons = {};
    for (const call of enrichedCalls) {
        if (!call.routed) continue;
        const reasonRaw = call.transferReason || call.transferIntent || 'unspecified';
        const reason = String(reasonRaw).trim().toLowerCase() || 'unspecified';
        transferReasons[reason] = (transferReasons[reason] || 0) + 1;
    }

    const routingRate = totalCalls > 0 ? Math.round((routedCalls / totalCalls) * 100) : 0;
    const transferAttemptRate = totalCalls > 0 ? Math.round((transferAttempted / totalCalls) * 100) : 0;
    const transferFailureRate = transferAttempted > 0
        ? Math.round(((transferAttempted - routedCalls) / transferAttempted) * 100)
        : 0;
    const spamRate = totalCalls > 0 ? Math.round((spamCalls / totalCalls) * 100) : 0;
    const spamLikelyRate = totalCalls > 0 ? Math.round((spamLikelyCalls / totalCalls) * 100) : 0;

    return {
        totalCalls,
        spamCalls,
        spamLikelyCalls,
        spamLikelyRate,
        intentIdentified,
        transferAttempted,
        routedCalls,
        notRoutedCalls,
        hangupBeforeRoute,
        routingRate,
        transferAttemptRate,
        transferFailureRate,
        spamRate,
        afterHoursCalls,
        notRoutedStats,
        notRoutedBuckets,
        routedStats,
        transferReasons,
        totalMinutes
    };
}

// Analyze Day of Week patterns
function analyzeDayOfWeek(enrichedCalls, heatmap) {
    const { getDay } = require('date-fns');

    const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const dayData = {};

    // Initialize data structure for each day
    for (let i = 0; i < 7; i++) {
        dayData[i] = {
            dayName: dayNames[i],
            calls: [],
            totalCalls: 0,
            eligibleLeads: 0,
            bookingCompleted: 0,
            hangupHighValue: 0,
            hangupModerate: 0,
            hangupLowValue: 0
        };
    }

    // Group calls by day of week
    for (const call of enrichedCalls) {
        if (!call.createdAt) continue;
        const callTime = toZonedTime(new Date(call.createdAt), TIME_ZONE);
        const dayOfWeek = getDay(callTime);

        dayData[dayOfWeek].calls.push(call);
        dayData[dayOfWeek].totalCalls++;

        // Count eligible leads
        if (['booking-completed', 'booking-abandoned', 'booking-transferred'].includes(call.category)) {
            dayData[dayOfWeek].eligibleLeads++;
            if (call.category === 'booking-completed') {
                dayData[dayOfWeek].bookingCompleted++;
            }
        }

        // Count hangup types
        if (call.category === 'hangup') {
            if (call.hangupType === 'high-value') dayData[dayOfWeek].hangupHighValue++;
            else if (call.hangupType === 'moderate') dayData[dayOfWeek].hangupModerate++;
            else if (call.hangupType === 'low-value') dayData[dayOfWeek].hangupLowValue++;
        }
    }

    // Calculate metrics for each day
    const results = [];
    const totalWeekCalls = enrichedCalls.length;

    for (let i = 0; i < 7; i++) {
        const day = dayData[i];
        const successRate = day.eligibleLeads > 0 ? Math.round((day.bookingCompleted / day.eligibleLeads) * 100) : 0;
        const percentOfWeek = totalWeekCalls > 0 ? Math.round((day.totalCalls / totalWeekCalls) * 100) : 0;

        // Calculate average duration
        const callsWithDuration = day.calls.filter(c => c.duration > 0);
        const avgDuration = callsWithDuration.length > 0
            ? Math.round(callsWithDuration.reduce((sum, c) => sum + c.duration, 0) / callsWithDuration.length)
            : 0;

        // Find peak hour for this day from heatmap
        let peakHour = 'N/A';
        let peakCount = 0;
        if (heatmap) {
            const dayAbbr = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'][i];
            for (const timeKey in heatmap) {
                if (heatmap[timeKey][dayAbbr] > peakCount) {
                    peakCount = heatmap[timeKey][dayAbbr];
                    peakHour = timeKey;
                }
            }
        }

        results.push({
            dayOfWeek: i,
            dayName: day.dayName,
            totalCalls: day.totalCalls,
            percentOfWeek,
            eligibleLeads: day.eligibleLeads,
            successRate,
            avgDuration,
            hangupHighValue: day.hangupHighValue,
            hangupModerate: day.hangupModerate,
            hangupLowValue: day.hangupLowValue,
            peakHour
        });
    }

    return results;
}

// Analyze Week of Month patterns
function analyzeWeekOfMonth(enrichedCalls, monthKey) {
    const { getDate } = require('date-fns');

    const weekData = {
        1: { calls: [], dateRange: '' },
        2: { calls: [], dateRange: '' },
        3: { calls: [], dateRange: '' },
        4: { calls: [], dateRange: '' },
        5: { calls: [], dateRange: '' }
    };

    // Group calls by week of month (calendar weeks: 1-7, 8-14, 15-21, 22-31)
    for (const call of enrichedCalls) {
        if (!call.createdAt) continue;
        const callDate = new Date(call.createdAt);
        const dayOfMonth = getDate(callDate);

        let weekNum;
        if (dayOfMonth <= 7) weekNum = 1;
        else if (dayOfMonth <= 14) weekNum = 2;
        else if (dayOfMonth <= 21) weekNum = 3;
        else if (dayOfMonth <= 28) weekNum = 4;
        else weekNum = 5;

        weekData[weekNum].calls.push(call);
    }

    // Calculate metrics for each week
    const results = [];

    for (let weekNum = 1; weekNum <= 5; weekNum++) {
        const week = weekData[weekNum];

        if (week.calls.length === 0) continue;

        const totalCalls = week.calls.length;
        const eligibleLeads = week.calls.filter(c =>
            ['booking-completed', 'booking-abandoned', 'booking-transferred'].includes(c.category)
        ).length;
        const bookingCompleted = week.calls.filter(c => c.category === 'booking-completed').length;
        const successRate = eligibleLeads > 0 ? Math.round((bookingCompleted / eligibleLeads) * 100) : 0;

        // Calculate average duration
        const callsWithDuration = week.calls.filter(c => c.duration > 0);
        const avgDuration = callsWithDuration.length > 0
            ? Math.round(callsWithDuration.reduce((sum, c) => sum + c.duration, 0) / callsWithDuration.length)
            : 0;

        // Determine date range
        const dates = week.calls.map(c => getDate(new Date(c.createdAt))).sort((a, b) => a - b);
        const startDay = dates[0];
        const endDay = dates[dates.length - 1];
        const dateRange = `${monthKey}-${startDay.toString().padStart(2, '0')} to ${monthKey}-${endDay.toString().padStart(2, '0')}`;

        // Add notes
        let notes = '';
        if (weekNum === 1) notes = 'Start of month';
        else if (weekNum === 2) notes = 'Mid-month';
        else if (weekNum === 4 || weekNum === 5) notes = 'End of month';

        results.push({
            weekNum,
            dateRange,
            totalCalls,
            eligibleLeads,
            successRate,
            avgDuration,
            notes
        });
    }

    return results;
}

// Format duration helper
function formatDuration(seconds) {
    const minutes = Math.floor(seconds / 60);
    const secs = Math.round(seconds % 60);
    return `${minutes}:${secs.toString().padStart(2, '0')}`;
}

function formatTransferReasonLabel(reason) {
    if (!reason) return 'Unspecified';
    return reason
        .replace(/[-_]/g, ' ')
        .replace(/\b\w/g, c => c.toUpperCase());
}

function getTransferReasonNote(reason, config) {
    const note = config.client.transferReasons?.[reason];
    if (!note) return '-';
    return note.split('. ')[0];
}

// Calculate grade from target
function calculateGrade(actual, target, higherIsBetter = true) {
    const percentage = (actual / target) * 100;

    if (higherIsBetter) {
        if (percentage >= 100) return 'A';
        if (percentage >= 90) return 'A-';
        if (percentage >= 85) return 'B+';
        if (percentage >= 80) return 'B';
        if (percentage >= 75) return 'B-';
        if (percentage >= 70) return 'C+';
        if (percentage >= 65) return 'C';
        if (percentage >= 60) return 'C-';
        return 'D';
    } else {
        // Lower is better (e.g., spam detection speed)
        if (percentage <= 100) return 'A';
        if (percentage <= 110) return 'A-';
        if (percentage <= 120) return 'B+';
        if (percentage <= 130) return 'B';
        return 'C';
    }
}

// Generate performance scorecard
function generateScorecard(metrics, previousMetrics, targets) {
    const scores = [];

    // Booking Success Rate
    scores.push({
        kpi: 'Booking Success Rate',
        value: `${metrics.successRate}%`,
        target: `${targets.bookingSuccessRate}%`,
        change: previousMetrics ? `${metrics.successRate - previousMetrics.successRate >= 0 ? '+' : ''}${metrics.successRate - previousMetrics.successRate}%` : '-',
        grade: calculateGrade(metrics.successRate, targets.bookingSuccessRate)
    });

    // Email Capture Rate
    scores.push({
        kpi: 'Email Capture Rate',
        value: `${metrics.emailCaptureRate}%`,
        target: `${targets.emailCaptureRate}%`,
        change: previousMetrics ? `${metrics.emailCaptureRate - previousMetrics.emailCaptureRate >= 0 ? '+' : ''}${metrics.emailCaptureRate - previousMetrics.emailCaptureRate}%` : '-',
        grade: calculateGrade(metrics.emailCaptureRate, targets.emailCaptureRate)
    });

    // Spam Detection Speed
    scores.push({
        kpi: 'Spam Detection Speed',
        value: `${metrics.avgSpamDuration}s`,
        target: `<${targets.spamDetectionSpeed}s`,
        change: previousMetrics ? `${metrics.avgSpamDuration - previousMetrics.avgSpamDuration >= 0 ? '+' : ''}${metrics.avgSpamDuration - previousMetrics.avgSpamDuration}s` : '-',
        grade: calculateGrade(metrics.avgSpamDuration, targets.spamDetectionSpeed, false)
    });

    // Avg Booking Duration
    scores.push({
        kpi: 'Avg Booking Duration',
        value: formatDuration(metrics.avgDurationByCategory['booking-completed']),
        target: formatDuration(targets.avgBookingDuration),
        change: previousMetrics && previousMetrics.avgDurationByCategory ? formatDuration(metrics.avgDurationByCategory['booking-completed'] - previousMetrics.avgDurationByCategory['booking-completed']) : '-',
        grade: 'A' // Manual assessment for now
    });

    return scores;
}

// Generate executive summary using GPT
async function generateExecutiveSummary(metrics, previousMetrics, weekKey) {
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const aiName = config.client.aiAssistantName;

    const prompt = `You are an executive reporting assistant analyzing ${aiName} (an AI phone assistant for ${config.client.name}) routing performance.

Generate a concise executive summary (3-4 paragraphs) based on this week's performance:

**Week ${weekKey} Performance:**
- Total Calls: ${metrics.totalCalls}${previousMetrics ? ` (${metrics.totalCalls > previousMetrics.totalCalls ? '+' : ''}${metrics.totalCalls - previousMetrics.totalCalls} vs last week)` : ''}
- Routed Calls: ${metrics.routedCalls} (${metrics.routingRate}% routing rate)${previousMetrics ? ` (${metrics.routingRate >= previousMetrics.routingRate ? '+' : ''}${metrics.routingRate - previousMetrics.routingRate}% vs last week)` : ''}
- Transfer Attempted: ${metrics.transferAttempted} (${metrics.transferAttemptRate}%)
- Transfer Failure Rate: ${metrics.transferFailureRate}%
- Not Routed: ${metrics.notRoutedCalls}
- Hangup Before Route: ${metrics.hangupBeforeRoute}
- Spam Calls: ${metrics.spamCalls} (${metrics.spamRate}%)
- Spam Likely (short/no speech): ${metrics.spamLikelyCalls} (${metrics.spamLikelyRate}%)
- After-Hours Calls: ${metrics.afterHoursCalls}
- Routed Duration (Avg/Median): ${formatDuration(metrics.routedStats.avg)} / ${formatDuration(metrics.routedStats.median)}
- Not-Routed Duration (Avg/P90): ${formatDuration(metrics.notRoutedStats.avg)} / ${formatDuration(metrics.notRoutedStats.p90)}

**IMPORTANT - Statistical Context:**
- Weeks with fewer than 20 total calls have lower statistical significance - temper analysis accordingly
- When comparing week-over-week, note if either week had <20 calls before drawing conclusions
- Avoid dramatic language for small sample sizes
- Include raw numbers with percentages where relevant (e.g., "80% (4/5)" not just "80%")

**Template Structure:**
1. **Performance Overview**: Highlight call volume, routing rate trends, and key wins
2. **Routing Effectiveness**: Focus on transfer attempts vs successful routes and failure rate
3. **Caller Experience**: Not-routed duration stats and hangups before route
4. **Strategic Insights**: One actionable insight or pattern worth noting

Keep it executive-friendly: focus on business impact, not technical details. Use specific numbers.`;

    try {
        const response = await openai.chat.completions.create({
            model: 'gpt-5.1',
            messages: [{ role: 'user', content: prompt }],
            temperature: 0.7,
            max_completion_tokens: 800
        });

        return response.choices[0].message.content.trim();
    } catch (error) {
        console.warn('Failed to generate AI summary:', error.message);
        return `**Week ${weekKey} Performance Overview**\n\n${aiName} handled ${metrics.totalCalls} calls this week${previousMetrics ? `, ${metrics.totalCalls > previousMetrics.totalCalls ? 'up' : 'down'} ${Math.abs(metrics.totalCalls - previousMetrics.totalCalls)} from last week` : ''}. Routing rate was ${metrics.routingRate}% with ${metrics.routedCalls} routed calls.\n\n**Key Opportunities:** ${metrics.notRoutedCalls} calls were not routed, and ${metrics.hangupBeforeRoute} callers hung up before routing completed.\n\n_(AI summary generation failed - using template)_`;
    }
}

// Main report generation function
async function generateWeeklyReport(weekKey, options = {}) {
    console.log(`\n=== Generating Weekly Executive Report for ${weekKey} ===`);

    const enrichmentMap = loadEnrichments();
    console.log(`Loaded ${enrichmentMap.size} enrichments`);

    // Load revenue data
    let revenueData = {};
    const revenueDataPath = path.join(config.paths.clientDir, 'config', 'revenue.json');
    if (fs.existsSync(revenueDataPath)) {
        revenueData = JSON.parse(fs.readFileSync(revenueDataPath, 'utf8'));
    }

    // Load all raw call files for the specified week
    const rawFiles = fs.readdirSync(config.paths.rawDir).filter(f => f.startsWith('vapi_calls_') && f.endsWith('.json')).sort();

    let allCalls = [];
    let weekCalls = [];
    let previousWeekCalls = [];

    // Determine week date range
    const [year, weekNum] = weekKey.split('-W').map(Number);
    const weekStart = startOfWeek(new Date(year, 0, 1 + (weekNum - 1) * 7), { weekStartsOn: 1 });
    const weekEnd = endOfWeek(weekStart, { weekStartsOn: 1 });

    console.log(`Week range: ${format(weekStart, 'yyyy-MM-dd')} to ${format(weekEnd, 'yyyy-MM-dd')}`);

    // Load calls for current week and previous week
    for (const file of rawFiles) {
        const dateStr = file.replace('vapi_calls_', '').replace('.json', '');
        const calls = JSON.parse(fs.readFileSync(path.join(config.paths.rawDir, file), 'utf8'));
        const date = parseISO(dateStr);

        if (date >= weekStart && date <= weekEnd) {
            weekCalls.push(...calls);
        }

        const previousWeekStart = subWeeks(weekStart, 1);
        const previousWeekEnd = subWeeks(weekEnd, 1);
        if (date >= previousWeekStart && date <= previousWeekEnd) {
            previousWeekCalls.push(...calls);
        }

        allCalls.push(...calls);
    }

    console.log(`Found ${weekCalls.length} calls for ${weekKey}`);
    console.log(`Found ${previousWeekCalls.length} calls for previous week`);

    // Process and enrich calls
    const enrichedCalls = processAndEnrichCalls(weekCalls, enrichmentMap);
    const enrichedPreviousCalls = previousWeekCalls.length > 0 ? processAndEnrichCalls(previousWeekCalls, enrichmentMap) : null;

    // Calculate metrics
    const metrics = calculateMetrics(enrichedCalls);
    const previousMetrics = enrichedPreviousCalls ? calculateMetrics(enrichedPreviousCalls) : null;

    // Generate executive summary
    console.log('Generating executive summary...');
    const executiveSummary = await generateExecutiveSummary(metrics, previousMetrics, weekKey);

    // Build Markdown Report
    const aiName = config.client.aiAssistantName;
    let md = `# ${aiName} Weekly Routing Report\n\n`;
    md += `## ${config.client.name} - Week ${weekKey}\n\n`;
    md += `**Report Generated:** ${new Date().toLocaleString('en-US', { timeZone: TIME_ZONE })}\n\n`;
    md += `---\n\n`;

    // Executive Summary
    md += `## Executive Summary\n\n`;
    md += executiveSummary;
    md += `\n\n---\n\n`;

    // Weekly routing summary
    md += `## Weekly Routing Summary\n\n`;
    md += `| Metric | Count | % |\n`;
    md += `|--------|-------|---|\n`;
    md += `| Total Calls | ${metrics.totalCalls} | 100% |\n`;
    md += `| Spam Calls | ${metrics.spamCalls} | ${metrics.spamRate}% |\n`;
    md += `| Intent Identified | ${metrics.intentIdentified} | - |\n`;
    md += `| Transfer Attempted | ${metrics.transferAttempted} | ${metrics.transferAttemptRate}% |\n`;
    md += `| Routed | ${metrics.routedCalls} | ${metrics.routingRate}% |\n`;
    md += `| Not Routed | ${metrics.notRoutedCalls} | - |\n`;
    md += `| Hangup Before Route | ${metrics.hangupBeforeRoute} | - |\n`;
    md += `| After-Hours Calls | ${metrics.afterHoursCalls} | - |\n\n`;

    md += `- **Transfer Failure Rate:** ${metrics.transferFailureRate}%\n\n`;

    // Duration quality
    md += `## Duration Quality\n\n`;
    md += `- **Routed Duration (Avg/Median):** ${formatDuration(metrics.routedStats.avg)} / ${formatDuration(metrics.routedStats.median)}\n`;
    md += `- **Not-Routed Duration (Avg/Median/P90):** ${formatDuration(metrics.notRoutedStats.avg)} / ${formatDuration(metrics.notRoutedStats.median)} / ${formatDuration(metrics.notRoutedStats.p90)}\n\n`;

    md += `### Not-Routed Duration Histogram\n\n`;
    md += `| Bucket | Count |\n`;
    md += `|--------|-------|\n`;
    for (const [bucket, count] of Object.entries(metrics.notRoutedBuckets)) {
        md += `| ${bucket} | ${count} |\n`;
    }
    md += `\n---\n\n`;

    // Transfer reasons (routed only)
    md += `## Transfer Breakdown by Reason (Routed Only)\n\n`;
    md += `| Reason | Count | % of Routed |\n`;
    md += `|--------|-------|-------------|\n`;
    const routedTotal = metrics.routedCalls;
    if (routedTotal === 0) {
        md += `| No routed calls | 0 | 0% |\n`;
    } else {
        for (const [reason, count] of Object.entries(metrics.transferReasons)) {
            const pct = ((count / routedTotal) * 100).toFixed(1);
            md += `| ${reason} | ${count} | ${pct}% |\n`;
        }
    }

    md += `\n---\n\n`;

    // Top 10 not-routed call summaries (week)
    md += `## Top 10 Not-Routed Call Summaries (Week)\n\n`;
    md += `| Date | Time | Duration | Ended Reason | Summary |\n`;
    md += `|------|------|----------|--------------|---------|\n`;
    const topNotRouted = [...weekCalls]
        .map(c => {
            const transferIntent = getTransferIntent(c);
            const transferAttempted = Boolean(transferIntent);
            const notRouted = !transferAttempted && (c.endedReason === 'customer-ended-call' || c.endedReason === 'assistant-ended-call');
            const duration = getCallDuration(c);
            return { ...c, _notRouted: notRouted, _duration: duration };
        })
        .filter(c => c._notRouted)
        .sort((a, b) => (b._duration || 0) - (a._duration || 0))
        .slice(0, 10);

    if (topNotRouted.length === 0) {
        md += `| No not-routed calls | - | - | - | - |\n`;
    } else {
        for (const call of topNotRouted) {
            const dateStr = call.createdAt ? format(toZonedTime(new Date(call.createdAt), TIME_ZONE), 'yyyy-MM-dd') : 'N/A';
            const timeStr = call.createdAt ? format(toZonedTime(new Date(call.createdAt), TIME_ZONE), 'h:mm a') : 'N/A';
            const summary = cleanSummaryText(call.summary || '');
            md += `| ${dateStr} | ${timeStr} | ${formatDuration(call._duration || 0)} | ${call.endedReason || 'unknown'} | ${summary} |\n`;
        }
    }

    md += `\n---\n\n`;

    // Save Markdown
    const mdPath = path.join(config.paths.reportsDir, `weekly_report_${weekKey}.md`);
    fs.writeFileSync(mdPath, md, 'utf8');
    console.log(`\n✅ Markdown report saved: ${mdPath}`);

    // Generate HTML version
    console.log('Generating HTML version...');
    const html = convertMarkdownToHTML(md, weekKey);
    const htmlPath = path.join(config.paths.reportsDir, `weekly_report_${weekKey}.html`);
    fs.writeFileSync(htmlPath, html, 'utf8');
    console.log(`✅ HTML report saved: ${htmlPath}`);

    console.log(`\n=== Weekly Report Complete ===`);
    console.log(`Week: ${weekKey}`);
    console.log(`Total Calls: ${metrics.totalCalls}`);
    console.log(`Routed Calls: ${metrics.routedCalls} (${metrics.routingRate}%)`);
    console.log(`Transfer Attempted: ${metrics.transferAttempted} (${metrics.transferAttemptRate}%)`);
}

// Convert Markdown to HTML
function convertMarkdownToHTML(markdown, weekKey) {
    const aiName = config.client.aiAssistantName;

    // Simple markdown to HTML conversion
    let html = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${aiName} Weekly Report - ${weekKey}</title>
    <style>
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif;
            line-height: 1.6;
            max-width: 1200px;
            margin: 0 auto;
            padding: 20px;
            background: #f5f5f5;
        }
        .container {
            background: white;
            padding: 40px;
            border-radius: 8px;
            box-shadow: 0 2px 4px rgba(0,0,0,0.1);
        }
        h1 { color: #2c3e50; border-bottom: 3px solid #3498db; padding-bottom: 10px; }
        h2 { color: #34495e; margin-top: 30px; border-bottom: 2px solid #ecf0f1; padding-bottom: 8px; }
        h3 { color: #7f8c8d; }
        table {
            width: 100%;
            border-collapse: collapse;
            margin: 20px 0;
        }
        th, td {
            padding: 12px;
            text-align: left;
            border: 1px solid #ddd;
        }
        th {
            background-color: #3498db;
            color: white;
            font-weight: bold;
        }
        tr:nth-child(even) {
            background-color: #f9f9f9;
        }
        hr {
            border: none;
            border-top: 2px solid #ecf0f1;
            margin: 30px 0;
        }
        .grade-A { color: #27ae60; font-weight: bold; }
        .grade-B { color: #f39c12; font-weight: bold; }
        .grade-C { color: #e67e22; font-weight: bold; }
        .grade-D { color: #e74c3c; font-weight: bold; }
    </style>
</head>
<body>
    <div class="container">
`;

    // Convert markdown to HTML (basic conversion)
    html += markdown
        .replace(/### (.*)/g, '<h3>$1</h3>')
        .replace(/## (.*)/g, '<h2>$1</h2>')
        .replace(/# (.*)/g, '<h1>$1</h1>')
        .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
        .replace(/\*(.*?)\*/g, '<em>$1</em>')
        .replace(/---/g, '<hr>')
        .replace(/\n\n/g, '</p><p>')
        .replace(/\n/g, '<br>');

    html += `
    </div>
</body>
</html>`;

    return html;
}

// Parse command line arguments for target week
let targetWeek = null;

if (weekArg) {
    targetWeek = weekArg.split('=')[1];
}

// Default to current week if not specified
if (!targetWeek) {
    const now = new Date();
    const week = getWeek(now);
    const year = getYear(now);
    targetWeek = `${year}-W${week}`;
}

generateWeeklyReport(targetWeek).catch(console.error);

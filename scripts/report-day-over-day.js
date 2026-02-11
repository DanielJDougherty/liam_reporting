/**
 * Day-Over-Day Report - Generic script for any client
 *
 * Usage: node report-day-over-day.js --client=bathfitter
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { parseISO, getWeek, getYear, getDay, format } = require('date-fns');
const { toZonedTime } = require('date-fns-tz');
const { loadClientConfig } = require('../core/config-loader');

// Parse command line arguments
const args = process.argv.slice(2);
const clientArg = args.find(arg => arg.startsWith('--client='));

if (!clientArg) {
    console.error('Error: --client argument is required');
    console.error('Usage: node report-day-over-day.js --client=<clientname>');
    process.exit(1);
}

const clientName = clientArg.split('=')[1];

const dateArg = args.find(arg => arg.startsWith('--date='));
const targetDate = dateArg ? dateArg.split('=')[1] : null;

// Load client configuration
const config = loadClientConfig(clientName);
const TIME_ZONE = config.client.timezone || 'America/New_York';

console.log(`=== Generating day-over-day report for ${config.client.name} ===`);
console.log(`AI Assistant: ${config.client.aiAssistantName}`);
console.log(`Timezone: ${TIME_ZONE}`);

// Load all enrichment data once
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

    // 6. Check all messages (user, assistant, and system)
    if (!email && call.messages) {
        for (const msg of call.messages) {
            if (msg.message) {
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
        duration = (end - start) / 1000; // seconds
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

function processCalls(calls, enrichmentMap) {
    return calls.map(call => {
        const enrichment = enrichmentMap.get(call.id);

        const email = extractEmail(call);
        const duration = getCallDuration(call);
        const transferIntent = getTransferIntent(call);
        const spamLikely = isSpamLikelyShortNoSpeech(call, duration);

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

        const transferAttempted = Boolean(transferIntent);
        const intentIdentified = Boolean(transferIntent || transferReason);

        // Determine routing status — exactly ONE per call, exhaustive partition
        let routingStatus;
        if (call.endedReason === 'assistant-forwarded-call') {
            routingStatus = 'routed';
        } else if (transferAttempted && call.endedReason === 'customer-ended-call') {
            routingStatus = 'hangup-before-route';
        } else if (spamLikely) {
            routingStatus = 'spam-likely';
        } else if (category === 'spam') {
            routingStatus = 'spam';
        } else {
            routingStatus = 'not-routed';
        }

        const routed = routingStatus === 'routed';
        const notRouted = routingStatus === 'not-routed';
        const hangupBeforeRoute = routingStatus === 'hangup-before-route';

        return {
            callId: call.id,
            createdAt: call.createdAt,
            endedReason: call.endedReason,
            category,
            hangupType,
            transferReason,
            spamType,
            email,
            duration,
            transferIntent,
            routingStatus,
            routed,
            transferAttempted,
            intentIdentified,
            notRouted,
            hangupBeforeRoute,
            summary: call.summary || 'No summary',
            spamLikely: spamLikely
        };
    });
}

function computeMetrics(calls, enrichmentMap) {
    const processedCalls = processCalls(calls, enrichmentMap);
    const totalCalls = processedCalls.length;

    const spamCalls = processedCalls.filter(c => c.routingStatus === 'spam').length;
    const spamLikelyCalls = processedCalls.filter(c => c.routingStatus === 'spam-likely').length;
    const intentIdentified = processedCalls.filter(c => c.intentIdentified).length;
    const transferAttempted = processedCalls.filter(c => c.transferAttempted).length;
    const routedCalls = processedCalls.filter(c => c.routingStatus === 'routed').length;
    const notRoutedCalls = processedCalls.filter(c => c.routingStatus === 'not-routed').length;
    const hangupBeforeRoute = processedCalls.filter(c => c.routingStatus === 'hangup-before-route').length;

    // Sanity check: all calls must be in exactly one routing bucket
    const accountedFor = routedCalls + notRoutedCalls + hangupBeforeRoute + spamLikelyCalls + spamCalls;
    if (accountedFor !== totalCalls) {
        console.warn(`WARNING: Routing categories (${accountedFor}) != Total Calls (${totalCalls}). ${totalCalls - accountedFor} calls uncategorized.`);
    }

    const notRoutedDurations = processedCalls.filter(c => c.notRouted && c.duration > 0).map(c => c.duration);
    const routedDurations = processedCalls.filter(c => c.routed && c.duration > 0).map(c => c.duration);

    const notRoutedStats = computeDurationStats(notRoutedDurations);
    const routedStats = computeDurationStats(routedDurations);
    const notRoutedBuckets = computeDurationBuckets(notRoutedDurations);

    const totalMinutes = processedCalls.reduce((sum, c) => sum + (c.duration || 0), 0) / 60;

    // After-hours calls (outside business hours)
    const businessHours = config.client.businessHours || { start: 8, end: 17, days: [1, 2, 3, 4, 5] };
    const afterHoursCalls = processedCalls.filter(c => {
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

    // Transfer reason breakdown (routed only)
    const transferReasons = {};
    for (const call of processedCalls) {
        if (!call.routed) continue;
        const reasonRaw = call.transferReason || call.transferIntent || 'unspecified';
        const reason = String(reasonRaw).trim().toLowerCase() || 'unspecified';
        transferReasons[reason] = (transferReasons[reason] || 0) + 1;
    }

    const routingRate = totalCalls > 0 ? Math.round((routedCalls / totalCalls) * 100) : 0;
    const transferAttemptRate = totalCalls > 0 ? Math.round((transferAttempted / totalCalls) * 100) : 0;
    const transferFailureRate = transferAttempted > 0 ? Math.round(((transferAttempted - routedCalls) / transferAttempted) * 100) : 0;
    const spamRate = totalCalls > 0 ? Math.round((spamCalls / totalCalls) * 100) : 0;
    const spamLikelyRate = totalCalls > 0 ? Math.round((spamLikelyCalls / totalCalls) * 100) : 0;

    return {
        processedCalls,
        totalCalls,
        spamCalls,
        spamLikelyCalls,
        spamLikelyRate,
        intentIdentified,
        transferAttempted,
        routedCalls,
        routingRate,
        transferAttemptRate,
        transferFailureRate,
        notRoutedCalls,
        notRoutedStats,
        notRoutedBuckets,
        routedStats,
        hangupBeforeRoute,
        afterHoursCalls,
        spamRate,
        transferReasons,
        totalMinutes,
        notRoutedDurationTotal: notRoutedDurations.reduce((sum, v) => sum + v, 0),
        notRoutedDurationCount: notRoutedDurations.length,
        routedDurationTotal: routedDurations.reduce((sum, v) => sum + v, 0),
        routedDurationCount: routedDurations.length
    };
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
    return durationSeconds <= 10 && !hasCustomerSpeech(call);
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

function buildDODExecutiveSummary(todayRow, dailyRows, dayOfWeekAverages) {
    if (!todayRow) return '';

    const todayDate = parseISO(todayRow.date);
    const todayLabel = format(todayDate, 'EEE, MMM d');

    const totalCalls = todayRow.totalCalls;
    const routedCalls = todayRow.routedCalls;
    const routingRate = todayRow.routingRate;
    const transferAttempted = todayRow.transferAttempted;
    const transferAttemptRate = todayRow.transferAttemptRate;
    const transferFailureRate = todayRow.transferFailureRate;
    const intentIdentified = todayRow.intentIdentified;
    const intentRate = totalCalls > 0 ? Math.round((intentIdentified / totalCalls) * 100) : 0;
    const afterHoursRate = totalCalls > 0 ? Math.round((todayRow.afterHoursCalls / totalCalls) * 100) : 0;

    const weekRows = dailyRows.filter(r => r.weekKey === todayRow.weekKey);
    const wtdTotal = weekRows.reduce((sum, r) => sum + r.totalCalls, 0);
    const wtdRouted = weekRows.reduce((sum, r) => sum + r.routedCalls, 0);
    const wtdRoutingRate = wtdTotal > 0 ? Math.round((wtdRouted / wtdTotal) * 100) : 0;

    const monthKey = todayRow.date.slice(0, 7);
    const monthRows = dailyRows.filter(r => r.date.startsWith(monthKey));
    const mtdTotal = monthRows.reduce((sum, r) => sum + r.totalCalls, 0);
    const mtdRouted = monthRows.reduce((sum, r) => sum + r.routedCalls, 0);
    const mtdRoutingRate = mtdTotal > 0 ? Math.round((mtdRouted / mtdTotal) * 100) : 0;

    const dowAvg = dayOfWeekAverages[todayRow.dayOfWeek];
    const dowAvgCalls = dowAvg ? dowAvg.totalCalls : null;
    const dowAvgRouting = dowAvg ? dowAvg.routingRate : null;

    const notRoutedAvg = formatDuration(todayRow.notRoutedStats.avg);
    const notRoutedP90 = formatDuration(todayRow.notRoutedStats.p90);

    const sampleSizeNote = totalCalls < 20
        ? 'Call volume is below 20, so directional insights should be interpreted cautiously.'
        : 'Call volume is above 20, giving a reasonable directional read on routing performance.';

    const dowComparison = dowAvg
        ? `Compared to the same weekday average (${dowAvgCalls} calls, ${dowAvgRouting}% routing), yesterday ran at ${totalCalls} calls with ${routingRate}% routing.`
        : 'No prior same‑weekday baseline was available for comparison.';

    const afterHoursInsight = afterHoursRate >= 20
        ? 'After‑hours volume is material; improving off‑hours workflows could lift overall routed share.'
        : 'After‑hours volume is modest; the primary lever remains improving in‑hours routing coverage.';

    return [
        `**1. Performance Overview**\nLiam handled ${totalCalls} calls on ${todayLabel}, with a routing rate of ${routingRate}% (${routedCalls}/${totalCalls}). ${sampleSizeNote} Week‑to‑date stands at ${wtdTotal} calls with a ${wtdRoutingRate}% routing rate, and month‑to‑date at ${mtdTotal} calls with a ${mtdRoutingRate}% routing rate. ${dowComparison}`,
        `**2. Routing Effectiveness**\nTransfer was attempted on ${transferAttempted} calls (${transferAttemptRate}%), with a ${transferFailureRate}% failure rate. Intent was identified on ${intentIdentified} calls (${intentRate}%), indicating how often the assistant could confidently route to a department. ${Math.max(intentIdentified - transferAttempted, 0)} call(s) showed intent but did not reach a transfer attempt.`,
        `**3. Caller Experience**\nNot‑routed calls totaled ${todayRow.notRoutedCalls}, with short durations (avg ${notRoutedAvg}, P90 ${notRoutedP90}). Hangups before route were ${todayRow.hangupBeforeRoute}. Spam remained low at ${todayRow.spamCalls} (${todayRow.spamRate}%), with ${todayRow.spamLikelyCalls} flagged as spam‑likely (short/no speech).`,
        `**4. Strategic Insights**\nAfter‑hours calls represented ${afterHoursRate}% of yesterday’s volume (${todayRow.afterHoursCalls}/${totalCalls}). ${afterHoursInsight} Focus next on lifting intent identification and reducing not‑routed outcomes while maintaining the low transfer failure rate.`
    ].join('\n\n');
}

function calculateDayOfWeekAverages(dailyRows, currentWeek) {
    // Calculate 4-week average for each day of week (0=Sunday, 6=Saturday)
    const dayOfWeekData = {}; // key: dayOfWeek (0-6), value: array of metrics for that day

    for (const row of dailyRows) {
        const dateObj = parseISO(row.date);
        const week = getWeek(dateObj);
        const year = getYear(dateObj);
        const weekKey = `${year}-W${week}`;
        const dayOfWeek = getDay(dateObj); // 0=Sunday, 6=Saturday

        // Only include rows from the last 4 weeks before current week
        if (weekKey !== currentWeek) {
            if (!dayOfWeekData[dayOfWeek]) {
                dayOfWeekData[dayOfWeek] = [];
            }
            dayOfWeekData[dayOfWeek].push(row);
        }
    }

    // Calculate averages for each day of week
    const averages = {};
    for (const dayOfWeek in dayOfWeekData) {
        const rows = dayOfWeekData[dayOfWeek].slice(-4); // Last 4 occurrences
        if (rows.length > 0) {
            averages[dayOfWeek] = {
                totalCalls: Math.round(rows.reduce((sum, r) => sum + r.totalCalls, 0) / rows.length),
                routingRate: Math.round(rows.reduce((sum, r) => sum + r.routingRate, 0) / rows.length),
                transferAttemptRate: Math.round(rows.reduce((sum, r) => sum + r.transferAttemptRate, 0) / rows.length),
                spamRate: Math.round(rows.reduce((sum, r) => sum + r.spamRate, 0) / rows.length),
                count: rows.length
            };
        }
    }

    return averages;
}

async function generateDayOverDayReport() {
    console.log('=== Generating Day-Over-Day Summary ===');
    const enrichmentMap = loadEnrichments();
    console.log(`Loaded ${enrichmentMap.size} enrichments`);

    const rawFiles = fs.readdirSync(config.paths.rawDir).filter(f => f.startsWith('vapi_calls_') && f.endsWith('.json')).sort();

    const dailyRows = [];
    const weeklyMap = new Map(); // key: `${year}-W${week}`
    const dailyCallsMap = new Map();

    // Process all raw files
    for (const file of rawFiles) {
        const dateStr = file.replace('vapi_calls_', '').replace('.json', '');
        const calls = JSON.parse(fs.readFileSync(path.join(config.paths.rawDir, file), 'utf8'));
        const metrics = computeMetrics(calls, enrichmentMap);
        dailyCallsMap.set(dateStr, metrics.processedCalls);

        const dateObj = parseISO(dateStr);
        const week = getWeek(dateObj);
        const year = getYear(dateObj);
        const weekKey = `${year}-W${week}`;
        const dayOfWeek = getDay(dateObj);
        const dayName = format(dateObj, 'EEE'); // Mon, Tue, Wed, etc.

        dailyRows.push({
            date: dateStr,
            weekKey,
            dayOfWeek,
            dayName,
            totalCalls: metrics.totalCalls,
            spamCalls: metrics.spamCalls,
            spamLikelyCalls: metrics.spamLikelyCalls,
            intentIdentified: metrics.intentIdentified,
            transferAttempted: metrics.transferAttempted,
            routedCalls: metrics.routedCalls,
            routingRate: metrics.routingRate,
            transferAttemptRate: metrics.transferAttemptRate,
            transferFailureRate: metrics.transferFailureRate,
            notRoutedCalls: metrics.notRoutedCalls,
            notRoutedStats: metrics.notRoutedStats,
            routedStats: metrics.routedStats,
            hangupBeforeRoute: metrics.hangupBeforeRoute,
            afterHoursCalls: metrics.afterHoursCalls,
            spamRate: metrics.spamRate,
            spamLikelyRate: metrics.spamLikelyRate,
            totalMinutes: metrics.totalMinutes,
            notRoutedDurationTotal: metrics.notRoutedDurationTotal,
            notRoutedDurationCount: metrics.notRoutedDurationCount,
            routedDurationTotal: metrics.routedDurationTotal,
            routedDurationCount: metrics.routedDurationCount
        });

        // Weekly aggregation
        if (!weeklyMap.has(weekKey)) {
            weeklyMap.set(weekKey, {
                totalCalls: metrics.totalCalls,
                spamCalls: metrics.spamCalls,
                spamLikelyCalls: metrics.spamLikelyCalls,
                intentIdentified: metrics.intentIdentified,
                transferAttempted: metrics.transferAttempted,
                routedCalls: metrics.routedCalls,
                notRoutedCalls: metrics.notRoutedCalls,
                hangupBeforeRoute: metrics.hangupBeforeRoute,
                afterHoursCalls: metrics.afterHoursCalls,
                totalMinutes: metrics.totalMinutes,
                notRoutedDurationTotal: metrics.notRoutedDurationTotal,
                notRoutedDurationCount: metrics.notRoutedDurationCount,
                routedDurationTotal: metrics.routedDurationTotal,
                routedDurationCount: metrics.routedDurationCount,
                days: 1
            });
        } else {
            const agg = weeklyMap.get(weekKey);
            agg.totalCalls += metrics.totalCalls;
            agg.spamCalls += metrics.spamCalls;
            agg.spamLikelyCalls += metrics.spamLikelyCalls;
            agg.intentIdentified += metrics.intentIdentified;
            agg.transferAttempted += metrics.transferAttempted;
            agg.routedCalls += metrics.routedCalls;
            agg.notRoutedCalls += metrics.notRoutedCalls;
            agg.hangupBeforeRoute += metrics.hangupBeforeRoute;
            agg.afterHoursCalls += metrics.afterHoursCalls;
            agg.totalMinutes += metrics.totalMinutes;
            agg.notRoutedDurationTotal += metrics.notRoutedDurationTotal;
            agg.notRoutedDurationCount += metrics.notRoutedDurationCount;
            agg.routedDurationTotal += metrics.routedDurationTotal;
            agg.routedDurationCount += metrics.routedDurationCount;
            agg.days += 1;
            weeklyMap.set(weekKey, agg);
        }
    }

    // Recalculate weekly rates from aggregated counts
    for (const [weekKey, agg] of weeklyMap.entries()) {
        agg.routingRate = agg.totalCalls > 0 ? Math.round((agg.routedCalls / agg.totalCalls) * 100) : 0;
        agg.transferAttemptRate = agg.totalCalls > 0 ? Math.round((agg.transferAttempted / agg.totalCalls) * 100) : 0;
        agg.transferFailureRate = agg.transferAttempted > 0
            ? Math.round(((agg.transferAttempted - agg.routedCalls) / agg.transferAttempted) * 100)
            : 0;
        agg.spamRate = agg.totalCalls > 0 ? Math.round((agg.spamCalls / agg.totalCalls) * 100) : 0;
        agg.spamLikelyRate = agg.totalCalls > 0 ? Math.round((agg.spamLikelyCalls / agg.totalCalls) * 100) : 0;
        agg.notRoutedAvgDuration = agg.notRoutedDurationCount > 0
            ? Math.round(agg.notRoutedDurationTotal / agg.notRoutedDurationCount)
            : 0;
        agg.routedAvgDuration = agg.routedDurationCount > 0
            ? Math.round(agg.routedDurationTotal / agg.routedDurationCount)
            : 0;
    }

    // Get the current week (last week in the data)
    const sortedWeeks = Array.from(weeklyMap.keys()).sort();
    const currentWeek = sortedWeeks[sortedWeeks.length - 1];

    // Calculate day-of-week averages for comparison
    const dayOfWeekAverages = calculateDayOfWeekAverages(dailyRows, currentWeek);

    const todayRow = targetDate
        ? dailyRows.find(r => r.date === targetDate) || dailyRows[dailyRows.length - 1]
        : dailyRows[dailyRows.length - 1];
    // Build markdown
    const aiName = config.client.aiAssistantName;
    let md = `# ${aiName} Day-Over-Day Call Summary\n\n`;
    md += `**${config.client.name}**\n`;
    md += `**Report Generated:** ${new Date().toLocaleString('en-US', { timeZone: TIME_ZONE })}\n\n`;

    // Executive Summary
    md += '## Executive Summary\n\n';
    md += buildDODExecutiveSummary(todayRow, dailyRows, dayOfWeekAverages);
    md += '\n\n---\n\n';

    // Daily comparison table
    md += '## Daily Performance (with Day-of-Week Comparison)\n\n';
    md += '| Date | Day | Total Calls | vs Avg | Spam | Intent Identified | Transfer Attempted | Routed | Routing % | vs Avg | Not Routed | Not Routed Avg | Not Routed P90 | Hangup Before Route | After-Hours |\n';
    md += '|------|-----|-------------|--------|------|------------------|--------------------|--------|-----------|--------|------------|---------------|---------------|----------------------|------------|\n';

    for (const r of dailyRows) {
        const avg = dayOfWeekAverages[r.dayOfWeek];
        let callsVsAvg = '';
        let routingVsAvg = '';

        if (avg) {
            const callsDiff = r.totalCalls - avg.totalCalls;
            const routingDiff = r.routingRate - avg.routingRate;
            callsVsAvg = callsDiff >= 0 ? `+${callsDiff} ???` : `${callsDiff} ???`;
            routingVsAvg = routingDiff >= 0 ? `+${routingDiff}% ???` : `${routingDiff}% ???`;
        }

        md += `| ${r.date} | ${r.dayName} | ${r.totalCalls} | ${callsVsAvg} | ${r.spamCalls} | ${r.intentIdentified} | ${r.transferAttempted} | ${r.routedCalls} | ${r.routingRate}% | ${routingVsAvg} | ${r.notRoutedCalls} | ${formatDuration(r.notRoutedStats.avg)} | ${formatDuration(r.notRoutedStats.p90)} | ${r.hangupBeforeRoute} | ${r.afterHoursCalls} |\n`;
    }

    // Weekly summary table
    md += '\n## Week-Over-Week Summary\n\n';
    md += '| Week | Days | Total Calls | Change | Spam | Intent Identified | Transfer Attempted | Routed | Routing % | Change | Not Routed | Not Routed Avg | Routed Avg | After-Hours |\n';
    md += '|------|------|-------------|--------|------|------------------|--------------------|--------|-----------|--------|------------|---------------|-----------|------------|\n';

    let previousWeek = null;
    for (const [weekKey, agg] of Array.from(weeklyMap.entries()).sort((a, b) => a[0].localeCompare(b[0]))) {
        let callsChange = '';
        let routingChange = '';

        if (previousWeek) {
            const callsDiff = agg.totalCalls - previousWeek.totalCalls;
            const callsPct = previousWeek.totalCalls > 0 ? Math.round((callsDiff / previousWeek.totalCalls) * 100) : 0;
            const routingDiff = agg.routingRate - previousWeek.routingRate;

            callsChange = callsDiff >= 0 ? `+${callsPct}% ???` : `${callsPct}% ???`;
            routingChange = routingDiff >= 0 ? `+${routingDiff}% ???` : `${routingDiff}% ???`;
        }

        md += `| ${weekKey} | ${agg.days} | ${agg.totalCalls} | ${callsChange} | ${agg.spamCalls} | ${agg.intentIdentified} | ${agg.transferAttempted} | ${agg.routedCalls} | ${agg.routingRate}% | ${routingChange} | ${agg.notRoutedCalls} | ${formatDuration(agg.notRoutedAvgDuration)} | ${formatDuration(agg.routedAvgDuration)} | ${agg.afterHoursCalls} |\n`;

        previousWeek = agg;
    }

    // Latest day deep dive
    const latestDate = todayRow ? todayRow.date : null;
    const latestCalls = latestDate ? (dailyCallsMap.get(latestDate) || []) : [];
    const latestNotRouted = latestCalls.filter(c => c.notRouted);
    const latestNotRoutedDurations = latestNotRouted.filter(c => c.duration > 0).map(c => c.duration);
    const latestNotRoutedStats = computeDurationStats(latestNotRoutedDurations);
    const latestNotRoutedBuckets = computeDurationBuckets(latestNotRoutedDurations);
    const latestRouted = latestCalls.filter(c => c.routed);
    const latestRoutedDurations = latestRouted.filter(c => c.duration > 0).map(c => c.duration);
    const latestRoutedStats = computeDurationStats(latestRoutedDurations);

    const latestTransferReasons = {};
    for (const call of latestRouted) {
        const reasonRaw = call.transferReason || call.transferIntent || 'unspecified';
        const reason = String(reasonRaw).trim().toLowerCase() || 'unspecified';
        latestTransferReasons[reason] = (latestTransferReasons[reason] || 0) + 1;
    }

    if (todayRow) {
        md += `\n## Latest Day Snapshot (${latestDate})\n\n`;
        md += `- **Total Calls:** ${todayRow.totalCalls}\n`;
        md += `- **Spam Calls:** ${todayRow.spamCalls} (${todayRow.spamRate}%)\n`;
        md += `- **Intent Identified:** ${todayRow.intentIdentified}\n`;
        md += `- **Transfer Attempted:** ${todayRow.transferAttempted} (${todayRow.transferAttemptRate}%)\n`;
        md += `- **Routed:** ${todayRow.routedCalls} (${todayRow.routingRate}%)\n`;
        md += `- **Transfer Failure Rate:** ${todayRow.transferFailureRate}%\n`;
        md += `- **Not Routed:** ${todayRow.notRoutedCalls}\n`;
        md += `- **Hangup Before Route:** ${todayRow.hangupBeforeRoute}\n`;
        md += `- **After-Hours Calls:** ${todayRow.afterHoursCalls}\n`;

        md += `\n### Not-Routed Duration Stats (Latest Day)\n\n`;
        md += `- Avg: ${formatDuration(latestNotRoutedStats.avg)}\n`;
        md += `- Median: ${formatDuration(latestNotRoutedStats.median)}\n`;
        md += `- P90: ${formatDuration(latestNotRoutedStats.p90)}\n\n`;

        md += `### Not-Routed Duration Histogram (Latest Day)\n\n`;
        md += `| Bucket | Count |\n`;
        md += `|--------|-------|\n`;
        for (const [bucket, count] of Object.entries(latestNotRoutedBuckets)) {
            md += `| ${bucket} | ${count} |\n`;
        }

        md += `\n### Routed Call Duration (Proxy for Time-to-Route)\n\n`;
        md += `- Avg: ${formatDuration(latestRoutedStats.avg)}\n`;
        md += `- Median: ${formatDuration(latestRoutedStats.median)}\n\n`;

        md += `### Routed Transfer Reasons (Latest Day)\n\n`;
        md += `| Reason | Count | % of Routed |\n`;
        md += `|--------|-------|-------------|\n`;
        const routedTotal = latestRouted.length;
        if (routedTotal === 0) {
            md += `| No routed calls | 0 | 0% |\n`;
        } else {
            for (const [reason, count] of Object.entries(latestTransferReasons)) {
                const pct = ((count / routedTotal) * 100).toFixed(1);
                md += `| ${reason} | ${count} | ${pct}% |\n`;
            }
        }

        md += `\n### Top 10 Not-Routed Call Summaries (Latest Day)\n\n`;
        md += `| Time | Duration | Ended Reason | Summary |\n`;
        md += `|------|----------|--------------|---------|\n`;
        const topNotRouted = [...latestNotRouted]
            .sort((a, b) => (b.duration || 0) - (a.duration || 0))
            .slice(0, 10);
        if (topNotRouted.length === 0) {
            md += `| No not-routed calls | - | - | - |\n`;
        } else {
            for (const call of topNotRouted) {
                const timeStr = call.createdAt
                    ? format(toZonedTime(new Date(call.createdAt), TIME_ZONE), 'h:mm a')
                    : 'N/A';
                const summary = cleanSummaryText(call.summary || '');
                md += `| ${timeStr} | ${formatDuration(call.duration || 0)} | ${call.endedReason || 'unknown'} | ${summary} |\n`;
            }
        }
    }

    // Additional context + trend sections
    if (todayRow) {
        const latestDate = todayRow.date;
        const latestCalls = dailyCallsMap.get(latestDate) || [];
        const latestTransferReasons = {};
        for (const call of latestCalls) {
            if (!call.routed) continue;
            const reasonRaw = call.transferReason || call.transferIntent || 'unspecified';
            const reason = String(reasonRaw).trim().toLowerCase() || 'unspecified';
            latestTransferReasons[reason] = (latestTransferReasons[reason] || 0) + 1;
        }

        // KPI Waterfall (Routing)
        md += `\n## KPI Waterfall (Routing) - ${latestDate}\n\n`;
        md += `| Stage | Calls | Rate |\n`;
        md += `|-------|-------|------|\n`;
        const realCalls = todayRow.totalCalls - todayRow.spamCalls;
        const transferFailed = todayRow.transferAttempted - todayRow.routedCalls;
        md += `| All Calls | ${todayRow.totalCalls} | 100% |\n`;
        md += `| Spam | ${todayRow.spamCalls} | ${todayRow.spamRate}% |\n`;
        md += `| Real Calls (excl Spam) | ${realCalls} | ${todayRow.totalCalls > 0 ? Math.round((realCalls / todayRow.totalCalls) * 100) : 0}% |\n`;
        md += `| Intent Identified | ${todayRow.intentIdentified} | ${todayRow.totalCalls > 0 ? Math.round((todayRow.intentIdentified / todayRow.totalCalls) * 100) : 0}% |\n`;
        md += `| Transfer Attempted | ${todayRow.transferAttempted} | ${todayRow.transferAttemptRate}% |\n`;
        md += `| ? Routed | ${todayRow.routedCalls} | ${todayRow.routingRate}% |\n`;
        md += `| ? Transfer Failed | ${transferFailed} | ${todayRow.transferAttempted > 0 ? Math.round((transferFailed / todayRow.transferAttempted) * 100) : 0}% of attempts |\n`;
        md += `| Not Routed (no attempt) | ${todayRow.notRoutedCalls} | ${todayRow.totalCalls > 0 ? Math.round((todayRow.notRoutedCalls / todayRow.totalCalls) * 100) : 0}% |\n`;
        md += `| Hangup Before Route | ${todayRow.hangupBeforeRoute} | ${todayRow.totalCalls > 0 ? Math.round((todayRow.hangupBeforeRoute / todayRow.totalCalls) * 100) : 0}% |\n`;
        md += `| Spam Likely (short/no speech) | ${todayRow.spamLikelyCalls} | ${todayRow.spamLikelyRate}% |\n`;

        // Transfer Breakdown (Today vs Last 7 Days)
        const last7Rows = dailyRows.slice(-7);
        const last7Calls = last7Rows.reduce((sum, r) => sum + r.totalCalls, 0);
        const last7Routed = last7Rows.reduce((sum, r) => sum + r.routedCalls, 0);
        const last7TransferReasons = {};
        for (const row of last7Rows) {
            const dayCalls = dailyCallsMap.get(row.date) || [];
            for (const call of dayCalls) {
                if (!call.routed) continue;
                const reasonRaw = call.transferReason || call.transferIntent || 'unspecified';
                const reason = String(reasonRaw).trim().toLowerCase() || 'unspecified';
                last7TransferReasons[reason] = (last7TransferReasons[reason] || 0) + 1;
            }
        }

        md += `\n## Transfer Breakdown (Today vs Last 7 Days)\n\n`;
        md += `| Destination | Today | % Today | Last 7 Days | % of 7-Day Calls |\n`;
        md += `|------------|-------|---------|-------------|------------------|\n`;
        const reasonKeys = new Set([...Object.keys(latestTransferReasons), ...Object.keys(last7TransferReasons)]);
        const sortedReasons = Array.from(reasonKeys);
        for (const reason of sortedReasons) {
            const todayCount = latestTransferReasons[reason] || 0;
            const todayPct = todayRow.routedCalls > 0 ? Math.round((todayCount / todayRow.routedCalls) * 100) : 0;
            const last7Count = last7TransferReasons[reason] || 0;
            const last7Pct = last7Calls > 0 ? Math.round((last7Count / last7Calls) * 100) : 0;
            md += `| ${formatTransferReasonLabel(reason)} | ${todayCount} | ${todayPct}% | ${last7Count} | ${last7Pct}% |\n`;
        }
        md += `| **Total Routed** | **${todayRow.routedCalls}** | **100%** | **${last7Routed}** | **${last7Calls > 0 ? Math.round((last7Routed / last7Calls) * 100) : 0}%** |\n`;

        // Period Comparisons
        md += `\n## Period Comparisons\n\n`;
        const previousRow = dailyRows.length > 1 ? dailyRows[dailyRows.length - 2] : null;
        if (previousRow) {
            md += `### ${todayRow.date} vs ${previousRow.date}\n\n`;
            md += `| Metric | ${todayRow.date} | ${previousRow.date} | ? |\n`;
            md += `|--------|------------|-------------|---|\n`;
            const dayDelta = (a, b) => a - b;
            const formatDelta = (d, suffix = '') => d >= 0 ? `+${d}${suffix} ?` : `${d}${suffix} ?`;
            md += `| Total Calls | ${todayRow.totalCalls} | ${previousRow.totalCalls} | ${formatDelta(dayDelta(todayRow.totalCalls, previousRow.totalCalls))} |\n`;
            md += `| Routed | ${todayRow.routedCalls} | ${previousRow.routedCalls} | ${formatDelta(dayDelta(todayRow.routedCalls, previousRow.routedCalls))} |\n`;
            md += `| Routing Rate | ${todayRow.routingRate}% | ${previousRow.routingRate}% | ${formatDelta(dayDelta(todayRow.routingRate, previousRow.routingRate), '%')} |\n`;
            md += `| Transfer Attempted | ${todayRow.transferAttempted} | ${previousRow.transferAttempted} | ${formatDelta(dayDelta(todayRow.transferAttempted, previousRow.transferAttempted))} |\n`;
            md += `| Spam Rate | ${todayRow.spamRate}% | ${previousRow.spamRate}% | ${formatDelta(dayDelta(todayRow.spamRate, previousRow.spamRate), '%')} |\n`;
            md += `| Not Routed | ${todayRow.notRoutedCalls} | ${previousRow.notRoutedCalls} | ${formatDelta(dayDelta(todayRow.notRoutedCalls, previousRow.notRoutedCalls))} |\n`;
            md += `| Not-Routed P90 | ${formatDuration(todayRow.notRoutedStats.p90)} | ${formatDuration(previousRow.notRoutedStats.p90)} | ${formatDelta(dayDelta(todayRow.notRoutedStats.p90, previousRow.notRoutedStats.p90), 's')} |\n`;
        }

        // Last 7 vs Prior 7
        const last7 = dailyRows.slice(-7);
        const prior7 = dailyRows.slice(-14, -7);
        if (last7.length > 0 && prior7.length > 0) {
            const sum = (rows, key) => rows.reduce((acc, r) => acc + (r[key] || 0), 0);
            const rate = (rows, numeratorKey) => {
                const total = sum(rows, 'totalCalls');
                const num = sum(rows, numeratorKey);
                return total > 0 ? Math.round((num / total) * 100) : 0;
            };
            const p90avg = (rows) => {
                if (!rows.length) return 0;
                const vals = rows.map(r => r.notRoutedStats.p90 || 0);
                return Math.round(vals.reduce((a, b) => a + b, 0) / vals.length);
            };

            md += `\n### Last 7 Days vs Prior 7 Days\n\n`;
            md += `| Metric | Last 7 | Prior 7 | ? |\n`;
            md += `|--------|--------|---------|---|\n`;
            const totalLast7 = sum(last7, 'totalCalls');
            const totalPrior7 = sum(prior7, 'totalCalls');
            md += `| Total Calls | ${totalLast7} | ${totalPrior7} | ${totalLast7 - totalPrior7 >= 0 ? '+' : ''}${totalLast7 - totalPrior7} |\n`;
            md += `| Routing Rate | ${rate(last7, 'routedCalls')}% | ${rate(prior7, 'routedCalls')}% | ${rate(last7, 'routedCalls') - rate(prior7, 'routedCalls') >= 0 ? '+' : ''}${rate(last7, 'routedCalls') - rate(prior7, 'routedCalls')}% |\n`;
            md += `| Transfer Attempt Rate | ${rate(last7, 'transferAttempted')}% | ${rate(prior7, 'transferAttempted')}% | ${rate(last7, 'transferAttempted') - rate(prior7, 'transferAttempted') >= 0 ? '+' : ''}${rate(last7, 'transferAttempted') - rate(prior7, 'transferAttempted')}% |\n`;
            md += `| Spam Rate | ${rate(last7, 'spamCalls')}% | ${rate(prior7, 'spamCalls')}% | ${rate(last7, 'spamCalls') - rate(prior7, 'spamCalls') >= 0 ? '+' : ''}${rate(last7, 'spamCalls') - rate(prior7, 'spamCalls')}% |\n`;
            md += `| Not-Routed P90 | ${formatDuration(p90avg(last7))} | ${formatDuration(p90avg(prior7))} | ${p90avg(last7) - p90avg(prior7) >= 0 ? '+' : ''}${p90avg(last7) - p90avg(prior7)}s |\n`;
        }

        // Last 30 vs Prior 30
        const last30 = dailyRows.slice(-30);
        const prior30 = dailyRows.slice(-60, -30);
        if (last30.length > 0 && prior30.length > 0) {
            const sum = (rows, key) => rows.reduce((acc, r) => acc + (r[key] || 0), 0);
            const rate = (rows, numeratorKey) => {
                const total = sum(rows, 'totalCalls');
                const num = sum(rows, numeratorKey);
                return total > 0 ? Math.round((num / total) * 100) : 0;
            };
            const p90avg = (rows) => {
                if (!rows.length) return 0;
                const vals = rows.map(r => r.notRoutedStats.p90 || 0);
                return Math.round(vals.reduce((a, b) => a + b, 0) / vals.length);
            };

            md += `\n### Last 30 Days vs Prior 30 Days\n\n`;
            md += `| Metric | Last 30 | Prior 30 | ? |\n`;
            md += `|--------|---------|----------|---|\n`;
            const totalLast30 = sum(last30, 'totalCalls');
            const totalPrior30 = sum(prior30, 'totalCalls');
            md += `| Total Calls | ${totalLast30} | ${totalPrior30} | ${totalLast30 - totalPrior30 >= 0 ? '+' : ''}${totalLast30 - totalPrior30} |\n`;
            md += `| Routing Rate | ${rate(last30, 'routedCalls')}% | ${rate(prior30, 'routedCalls')}% | ${rate(last30, 'routedCalls') - rate(prior30, 'routedCalls') >= 0 ? '+' : ''}${rate(last30, 'routedCalls') - rate(prior30, 'routedCalls')}% |\n`;
            md += `| Transfer Attempt Rate | ${rate(last30, 'transferAttempted')}% | ${rate(prior30, 'transferAttempted')}% | ${rate(last30, 'transferAttempted') - rate(prior30, 'transferAttempted') >= 0 ? '+' : ''}${rate(last30, 'transferAttempted') - rate(prior30, 'transferAttempted')}% |\n`;
            md += `| Spam Rate | ${rate(last30, 'spamCalls')}% | ${rate(prior30, 'spamCalls')}% | ${rate(last30, 'spamCalls') - rate(prior30, 'spamCalls') >= 0 ? '+' : ''}${rate(last30, 'spamCalls') - rate(prior30, 'spamCalls')}% |\n`;
            md += `| Not-Routed P90 | ${formatDuration(p90avg(last30))} | ${formatDuration(p90avg(prior30))} | ${p90avg(last30) - p90avg(prior30) >= 0 ? '+' : ''}${p90avg(last30) - p90avg(prior30)}s |\n`;
        }

        // Daily Performance (Rolling 14 Days)
        const dailyWindow = dailyRows.slice(-14);
        md += `\n## Daily Performance (Rolling 14 Days)\n\n`;
        md += `| Date | Day | Total | Spam | Spam Likely | Intent | Attempted | Routed | Routing % | Not Routed | Not-Routed P90 | After-Hours |\n`;
        md += `|------|-----|-------|------|------------|--------|-----------|--------|-----------|------------|---------------|------------|\n`;
        for (const r of dailyWindow) {
            md += `| ${r.date} | ${r.dayName} | ${r.totalCalls} | ${r.spamCalls} | ${r.spamLikelyCalls} | ${r.intentIdentified} | ${r.transferAttempted} | ${r.routedCalls} | ${r.routingRate}% | ${r.notRoutedCalls} | ${formatDuration(r.notRoutedStats.p90)} | ${r.afterHoursCalls} |\n`;
        }

        // Weekly Trends (Rolling 4 Weeks)
        md += `\n## Weekly Trends (Rolling 4 Weeks)\n\n`;
        md += `| Week | Total | Spam | Spam Likely | Attempted | Routed | Routing % | Not-Routed P90 | After-Hours |\n`;
        md += `|------|-------|------|------------|-----------|--------|-----------|---------------|------------|\n`;
        const weeklyRows = Array.from(weeklyMap.entries()).sort((a, b) => a[0].localeCompare(b[0])).slice(-4);
        for (const [wk, agg] of weeklyRows) {
            md += `| ${wk} | ${agg.totalCalls} | ${agg.spamCalls} | ${agg.spamLikelyCalls || 0} | ${agg.transferAttempted} | ${agg.routedCalls} | ${agg.routingRate}% | ${formatDuration(agg.notRoutedAvgDuration || 0)} | ${agg.afterHoursCalls} |\n`;
        }

        // Monthly Trends (Rolling 12 Months)
        const monthly = new Map();
        for (const r of dailyRows) {
            const monthKey = r.date.slice(0, 7);
            if (!monthly.has(monthKey)) {
                monthly.set(monthKey, {
                    totalCalls: 0,
                    spamCalls: 0,
                    spamLikelyCalls: 0,
                    transferAttempted: 0,
                    routedCalls: 0,
                    notRoutedP90Sum: 0,
                    notRoutedP90Count: 0
                });
            }
            const m = monthly.get(monthKey);
            m.totalCalls += r.totalCalls;
            m.spamCalls += r.spamCalls;
            m.spamLikelyCalls += r.spamLikelyCalls || 0;
            m.transferAttempted += r.transferAttempted;
            m.routedCalls += r.routedCalls;
            m.notRoutedP90Sum += r.notRoutedStats.p90 || 0;
            m.notRoutedP90Count += 1;
            monthly.set(monthKey, m);
        }

        const monthlyRows = Array.from(monthly.entries()).sort((a, b) => a[0].localeCompare(b[0])).slice(-12);
        md += `\n## Monthly Trends (Rolling 12 Months)\n\n`;
        md += `| Month | Total | Spam | Spam Likely | Attempted | Routed | Routing % | Not-Routed P90 |\n`;
        md += `|-------|-------|------|------------|-----------|--------|-----------|---------------|\n`;
        for (const [monthKey, m] of monthlyRows) {
            const routingRate = m.totalCalls > 0 ? Math.round((m.routedCalls / m.totalCalls) * 100) : 0;
            const notRoutedP90Avg = m.notRoutedP90Count > 0 ? Math.round(m.notRoutedP90Sum / m.notRoutedP90Count) : 0;
            md += `| ${monthKey} | ${m.totalCalls} | ${m.spamCalls} | ${m.spamLikelyCalls} | ${m.transferAttempted} | ${m.routedCalls} | ${routingRate}% | ${formatDuration(notRoutedP90Avg)} |\n`;
        }

        // Repeat Callers (Rolling 3 Days)
        const repeatWindow = dailyRows.slice(-3);
        const repeatCalls = [];
        for (const row of repeatWindow) {
            const dayCalls = dailyCallsMap.get(row.date) || [];
            repeatCalls.push(...dayCalls);
        }
        const repeatMap = new Map();
        for (const call of repeatCalls) {
            const number = call.customerNumber || call.phoneNumber || call.customer?.number || 'Unknown';
            if (!repeatMap.has(number)) repeatMap.set(number, []);
            repeatMap.get(number).push(call);
        }
        const repeatEntries = Array.from(repeatMap.entries())
            .filter(([num, calls]) => num !== 'Unknown' && calls.length > 1)
            .map(([num, calls]) => ({ num, calls }))
            .sort((a, b) => b.calls.length - a.calls.length);

        md += `\n## Repeat Callers (Last 3 Days)\n\n`;
        if (repeatEntries.length === 0) {
            md += `No repeat callers found in the last 3 days.\n`;
        } else {
            for (const entry of repeatEntries) {
                const sorted = entry.calls.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
                const first = sorted[0];
                const last = sorted[sorted.length - 1];
                const spanMinutes = first && last ? Math.round((new Date(last.createdAt) - new Date(first.createdAt)) / 60000) : 0;
                md += `- ${entry.num} - ${entry.calls.length} calls over ${spanMinutes} mins\n`;
                for (const c of sorted) {
                    const timeStr = c.createdAt ? format(toZonedTime(new Date(c.createdAt), TIME_ZONE), 'MM.dd @h:mma').replace('AM', 'a').replace('PM', 'p') : 'N/A';
                    const status = c.routed ? 'routed' : (c.notRouted ? 'not-routed' : c.category || 'unknown');
                    md += `  - ${timeStr} (${status})\n`;
                }
            }
        }

        // Appendix: All Calls (Latest Day)
        md += `\n## Appendix A: All Calls (${latestDate})\n\n`;
        md += `| Time | Caller | Duration | Routed | Category | Status/Type | Summary |\n`;
        md += `|------|--------|----------|--------|----------|-------------|---------|\n`;
        for (const call of latestCalls) {
            const timeStr = call.createdAt ? format(toZonedTime(new Date(call.createdAt), TIME_ZONE), 'h:mm a') : 'N/A';
            const caller = call.customerNumber || call.phoneNumber || call.customer?.number || 'Unknown';
            const statusType = call.routed
                ? (call.transferReason || call.transferIntent || 'N/A')
                : (call.category === 'spam' ? (call.spamType || 'spam') : (call.hangupType || call.endedReason || 'N/A'));
            const summary = cleanSummaryText(call.summary || '');
            md += `| ${timeStr} | ${caller} | ${formatDuration(call.duration || 0)} | ${call.routed ? 'Yes' : 'No'} | ${categoryEmoji(call.category)} | ${statusType} | ${summary} |\n`;
        }
    }

    // Add detailed metrics breakdown
    md += '\n## Key Metrics Definitions\n\n';
    md += '- **Intent Identified**: Transfer intent detected (tool call) or transfer reason assigned by enrichment\n';
    md += '- **Transfer Attempted**: Transfer tool invoked (attempted transfer)\n';
    md += '- **Routed**: Call ended with `assistant-forwarded-call`\n';
    md += '- **Not Routed**: No transfer attempt and call ended by customer or assistant\n';
    md += '- **Hangup Before Route**: Transfer attempted, caller hung up before connection\n';
    md += '- **vs Avg**: Comparison to 4-week average for same day of week\n';
    md += '- **Change**: Week-over-week percentage change\n\n';

    // Generate timestamped filename
    const now = new Date();
    const timestamp = format(now, 'yyyyMMdd_HHmmss');
    const firstRow = dailyRows[0];

    // Format date range for filename (MMDDYYYY)
    const startParts = firstRow ? firstRow.date.split('-') : ['0000', '00', '00'];
    const endDate = targetDate || (todayRow ? todayRow.date : null);
    const endParts = endDate ? endDate.split('-') : ['0000', '00', '00'];
    const startFormatted = `${startParts[1]}${startParts[2]}${startParts[0]}`;
    const endFormatted = `${endParts[1]}${endParts[2]}${endParts[0]}`;

    const fileName = `EngAgent_DODReport_Start${startFormatted}_End${endFormatted}_${timestamp}.md`;
    const outPath = path.join(config.paths.reportsDir, fileName);
    fs.writeFileSync(outPath, md);

    // Generate companion _meta.json for email sender
    const reportDateDisplay = targetDate || (todayRow ? todayRow.date : format(now, 'yyyy-MM-dd'));
    const periodRows = targetDate ? dailyRows.filter(r => r.date <= targetDate) : dailyRows;
    const periodTotalCalls = periodRows.reduce((sum, r) => sum + r.totalCalls, 0);
    const periodRouted = periodRows.reduce((sum, r) => sum + r.routedCalls, 0);
    const periodRoutingRate = periodTotalCalls > 0 ? ((periodRouted / periodTotalCalls) * 100).toFixed(2) : '0';

    const meta = {
        titleLine: `Executive Summary for ${reportDateDisplay}`,
        generatedTs: now.toLocaleString('en-US', { timeZone: TIME_ZONE }),
        dateRange: `${firstRow ? firstRow.date : ''} -> ${todayRow ? todayRow.date : ''}`,
        reportPath: outPath,
        callsToday: todayRow ? todayRow.totalCalls.toLocaleString() : '0',
        todaySuccessRate: todayRow ? `${todayRow.routingRate}%` : '0%',
        callsInPeriod: periodTotalCalls.toLocaleString(),
        periodSuccessRate: `${periodRoutingRate}%`
    };

    const metaPath = outPath.replace('.md', '_meta.json');
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));

    console.log(`\n=== Day-Over-Day Report Complete ===`);
    console.log(`Report saved to: ${outPath}`);
    console.log(`Metadata saved to: ${metaPath}`);
}

generateDayOverDayReport().catch(console.error);

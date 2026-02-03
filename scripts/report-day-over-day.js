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

function computeMetrics(calls, enrichmentMap) {
    const enrichedCalls = calls.map(call => {
        const enrichment = enrichmentMap.get(call.id);

        // Extract email and duration
        const email = extractEmail(call);
        let duration = call.duration || 0;
        if (!duration && call.startedAt && call.endedAt) {
            const start = new Date(call.startedAt);
            const end = new Date(call.endedAt);
            duration = (end - start) / 1000; // Convert to seconds
        }

        // Extract classification using UNIFIED TAXONOMY
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

        return {
            callId: call.id,
            category,
            hangupType,
            transferReason,
            spamType,
            email,
            duration
        };
    });

    const totalCalls = enrichedCalls.length;

    // UNIFIED TAXONOMY: booking-completed, booking-abandoned, booking-transferred, transferred, spam, hangup
    const bookingCompleted = enrichedCalls.filter(c => c.category === 'booking-completed').length;
    const bookingAbandoned = enrichedCalls.filter(c => c.category === 'booking-abandoned').length;
    const bookingTransferred = enrichedCalls.filter(c => c.category === 'booking-transferred').length;
    const transferred = enrichedCalls.filter(c => c.category === 'transferred').length;
    const spam = enrichedCalls.filter(c => c.category === 'spam').length;

    // Hangup breakdown by engagement level
    const hangupHighValue = enrichedCalls.filter(c => c.category === 'hangup' && c.hangupType === 'high-value').length;
    const hangupModerate = enrichedCalls.filter(c => c.category === 'hangup' && c.hangupType === 'moderate').length;
    const hangupLowValue = enrichedCalls.filter(c => c.category === 'hangup' && c.hangupType === 'low-value').length;
    const hangupTotal = hangupHighValue + hangupModerate + hangupLowValue;

    // Unknown/uncategorized calls (for debugging)
    const unknown = enrichedCalls.filter(c =>
        !['booking-completed', 'booking-abandoned', 'booking-transferred', 'transferred', 'spam', 'hangup'].includes(c.category)
    ).length;

    // Metrics calculations
    const eligibleLeads = bookingCompleted + bookingAbandoned + bookingTransferred;
    const successRate = eligibleLeads > 0 ? Math.round((bookingCompleted / eligibleLeads) * 100) : 0;

    // Email capture metrics
    const emailsCaptured = enrichedCalls.filter(c => c.email && c.email !== 'N/A').length;
    const emailCaptureRate = totalCalls > 0 ? Math.round((emailsCaptured / totalCalls) * 100) : 0;

    // Duration metrics (in seconds)
    const callsWithDuration = enrichedCalls.filter(c => c.duration > 0);
    const avgDuration = callsWithDuration.length > 0
        ? Math.round(callsWithDuration.reduce((sum, c) => sum + c.duration, 0) / callsWithDuration.length)
        : 0;

    // Average duration by outcome type
    const avgDurationByCategory = {};
    ['booking-completed', 'booking-abandoned', 'booking-transferred', 'transferred', 'spam', 'hangup'].forEach(cat => {
        const callsInCat = enrichedCalls.filter(c => c.category === cat && c.duration > 0);
        if (callsInCat.length > 0) {
            avgDurationByCategory[cat] = Math.round(callsInCat.reduce((sum, c) => sum + c.duration, 0) / callsInCat.length);
        } else {
            avgDurationByCategory[cat] = 0;
        }
    });

    // Calculate total connected minutes
    const totalMinutes = enrichedCalls.reduce((sum, c) => sum + (c.duration || 0), 0) / 60;

    return {
        totalCalls,
        bookingCompleted,
        bookingAbandoned,
        bookingTransferred,
        eligibleLeads,
        successRate,
        transferred,
        spam,
        hangupHighValue,
        hangupModerate,
        hangupLowValue,
        hangupTotal,
        unknown,
        emailsCaptured,
        emailCaptureRate,
        avgDuration,
        avgDurationByCategory,
        totalMinutes
    };
}

function formatDuration(seconds) {
    const minutes = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${minutes}:${secs.toString().padStart(2, '0')}`;
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
                eligibleLeads: Math.round(rows.reduce((sum, r) => sum + r.eligibleLeads, 0) / rows.length),
                bookingCompleted: Math.round(rows.reduce((sum, r) => sum + r.bookingCompleted, 0) / rows.length),
                successRate: Math.round(rows.reduce((sum, r) => sum + r.successRate, 0) / rows.length),
                emailCaptureRate: Math.round(rows.reduce((sum, r) => sum + r.emailCaptureRate, 0) / rows.length),
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

    // Process all raw files
    for (const file of rawFiles) {
        const dateStr = file.replace('vapi_calls_', '').replace('.json', '');
        const calls = JSON.parse(fs.readFileSync(path.join(config.paths.rawDir, file), 'utf8'));
        const metrics = computeMetrics(calls, enrichmentMap);

        const dateObj = parseISO(dateStr);
        const week = getWeek(dateObj);
        const year = getYear(dateObj);
        const weekKey = `${year}-W${week}`;
        const dayOfWeek = getDay(dateObj);
        const dayName = format(dateObj, 'EEE'); // Mon, Tue, Wed, etc.

        dailyRows.push({ date: dateStr, weekKey, dayOfWeek, dayName, ...metrics });

        // Weekly aggregation
        if (!weeklyMap.has(weekKey)) {
            weeklyMap.set(weekKey, { ...metrics, days: 1 });
        } else {
            const agg = weeklyMap.get(weekKey);
            for (const key of Object.keys(metrics)) {
                if (typeof metrics[key] === 'number' && key !== 'successRate' && key !== 'emailCaptureRate' && key !== 'avgDuration') {
                    agg[key] = (agg[key] || 0) + metrics[key];
                }
            }
            agg.days = (agg.days || 0) + 1;
            weeklyMap.set(weekKey, agg);
        }
    }

    // Recalculate weekly rates from aggregated counts
    for (const [weekKey, agg] of weeklyMap.entries()) {
        agg.successRate = agg.eligibleLeads > 0 ? Math.round((agg.bookingCompleted / agg.eligibleLeads) * 100) : 0;
        agg.emailCaptureRate = agg.totalCalls > 0 ? Math.round((agg.emailsCaptured / agg.totalCalls) * 100) : 0;
    }

    // Get the current week (last week in the data)
    const sortedWeeks = Array.from(weeklyMap.keys()).sort();
    const currentWeek = sortedWeeks[sortedWeeks.length - 1];

    // Calculate day-of-week averages for comparison
    const dayOfWeekAverages = calculateDayOfWeekAverages(dailyRows, currentWeek);

    // Build markdown
    const aiName = config.client.aiAssistantName;
    let md = `# ${aiName} Day-Over-Day Call Summary\n\n`;
    md += `**${config.client.name}**\n`;
    md += `**Report Generated:** ${new Date().toLocaleString('en-US', { timeZone: TIME_ZONE })}\n\n`;

    // Daily comparison table
    md += '## Daily Performance (with Day-of-Week Comparison)\n\n';
    md += '| Date | Day | Total Calls | vs Avg | Booking Completed | Booking Abandoned | Booking Transferred | Eligible Leads | Success % | vs Avg | Transferred | Spam | Hangup (H/M/L) | Email % | Avg Duration |\n';
    md += '|------|-----|-------------|--------|-------------------|-------------------|---------------------|----------------|-----------|--------|-------------|------|----------------|---------|-------------|\n';

    for (const r of dailyRows) {
        const avg = dayOfWeekAverages[r.dayOfWeek];
        let callsVsAvg = '';
        let successVsAvg = '';

        if (avg) {
            const callsDiff = r.totalCalls - avg.totalCalls;
            const successDiff = r.successRate - avg.successRate;
            callsVsAvg = callsDiff >= 0 ? `+${callsDiff} ↑` : `${callsDiff} ↓`;
            successVsAvg = successDiff >= 0 ? `+${successDiff}% ↑` : `${successDiff}% ↓`;
        }

        const hangupBreakdown = `${r.hangupHighValue}/${r.hangupModerate}/${r.hangupLowValue}`;

        md += `| ${r.date} | ${r.dayName} | ${r.totalCalls} | ${callsVsAvg} | ${r.bookingCompleted} | ${r.bookingAbandoned} | ${r.bookingTransferred} | ${r.eligibleLeads} | ${r.successRate}% | ${successVsAvg} | ${r.transferred} | ${r.spam} | ${hangupBreakdown} | ${r.emailCaptureRate}% | ${formatDuration(r.avgDuration)} |\n`;
    }

    // Weekly summary table
    md += '\n## Week-Over-Week Summary\n\n';
    md += '| Week | Days | Total Calls | Change | Booking Completed | Booking Abandoned | Booking Transferred | Eligible Leads | Success % | Change | Email % | Avg Duration | Connected Mins |\n';
    md += '|------|------|-------------|--------|-------------------|-------------------|---------------------|----------------|-----------|--------|---------|--------------|----------------|\n';

    let previousWeek = null;
    for (const [weekKey, agg] of Array.from(weeklyMap.entries()).sort((a, b) => a[0].localeCompare(b[0]))) {
        let callsChange = '';
        let successChange = '';

        if (previousWeek) {
            const callsDiff = agg.totalCalls - previousWeek.totalCalls;
            const callsPct = previousWeek.totalCalls > 0 ? Math.round((callsDiff / previousWeek.totalCalls) * 100) : 0;
            const successDiff = agg.successRate - previousWeek.successRate;

            callsChange = callsDiff >= 0 ? `+${callsPct}% ↑` : `${callsPct}% ↓`;
            successChange = successDiff >= 0 ? `+${successDiff}% ↑` : `${successDiff}% ↓`;
        }

        md += `| ${weekKey} | ${agg.days} | ${agg.totalCalls} | ${callsChange} | ${agg.bookingCompleted} | ${agg.bookingAbandoned} | ${agg.bookingTransferred} | ${agg.eligibleLeads} | ${agg.successRate}% | ${successChange} | ${agg.emailCaptureRate}% | ${formatDuration(Math.round(agg.avgDuration))} | ${Math.round(agg.totalMinutes)} |\n`;

        previousWeek = agg;
    }

    // Add detailed metrics breakdown
    md += '\n## Key Metrics Definitions\n\n';
    md += '- **Eligible Leads**: Booking Completed + Booking Abandoned + Booking Transferred (all calls where booking was attempted)\n';
    md += '- **Success Rate**: Booking Completed ÷ Eligible Leads × 100%\n';
    md += '- **Hangup (H/M/L)**: High-value / Moderate / Low-value engagement levels\n';
    md += '- **vs Avg**: Comparison to 4-week average for same day of week\n';
    md += '- **Change**: Week-over-week percentage change\n\n';

    md += '## Taxonomy\n\n';
    md += '**Main Categories:**\n';
    md += '- `booking-completed`: Customer successfully completed appointment booking\n';
    md += '- `booking-abandoned`: Customer started booking but did not complete\n';
    md += '- `booking-transferred`: Booking attempt was transferred to human\n';
    md += '- `transferred`: Call transferred without booking attempt\n';
    md += '- `spam`: Spam, robocalls, wrong numbers\n';
    md += '- `hangup`: Customer hung up (categorized by engagement level)\n\n';

    // Generate timestamped filename
    const now = new Date();
    const timestamp = format(now, 'yyyyMMdd_HHmmss');
    const todayRow = dailyRows[dailyRows.length - 1];
    const firstRow = dailyRows[0];

    // Format date range for filename (MMDDYYYY)
    const startParts = firstRow ? firstRow.date.split('-') : ['0000', '00', '00'];
    const endParts = todayRow ? todayRow.date.split('-') : ['0000', '00', '00'];
    const startFormatted = `${startParts[1]}${startParts[2]}${startParts[0]}`;
    const endFormatted = `${endParts[1]}${endParts[2]}${endParts[0]}`;

    const fileName = `EngAgent_DODReport_Start${startFormatted}_End${endFormatted}_${timestamp}.md`;
    const outPath = path.join(config.paths.reportsDir, fileName);
    fs.writeFileSync(outPath, md);

    // Generate companion _meta.json for email sender
    const reportDateDisplay = todayRow ? todayRow.date : format(now, 'yyyy-MM-dd');
    const periodTotalCalls = dailyRows.reduce((sum, r) => sum + r.totalCalls, 0);
    const periodBookings = dailyRows.reduce((sum, r) => sum + r.bookingCompleted, 0);
    const periodEligible = dailyRows.reduce((sum, r) => sum + r.eligibleLeads, 0);
    const periodSuccessRate = periodEligible > 0 ? ((periodBookings / periodEligible) * 100).toFixed(2) : '0';

    const meta = {
        titleLine: `Executive Summary for ${reportDateDisplay}`,
        generatedTs: now.toLocaleString('en-US', { timeZone: TIME_ZONE }),
        dateRange: `${firstRow ? firstRow.date : ''} -> ${todayRow ? todayRow.date : ''}`,
        reportPath: outPath,
        callsToday: todayRow ? todayRow.totalCalls.toLocaleString() : '0',
        todaySuccessRate: todayRow ? `${todayRow.successRate}%` : '0%',
        callsInPeriod: periodTotalCalls.toLocaleString(),
        periodSuccessRate: `${periodSuccessRate}%`
    };

    const metaPath = outPath.replace('.md', '_meta.json');
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));

    console.log(`\n=== Day-Over-Day Report Complete ===`);
    console.log(`Report saved to: ${outPath}`);
    console.log(`Metadata saved to: ${metaPath}`);
}

generateDayOverDayReport().catch(console.error);

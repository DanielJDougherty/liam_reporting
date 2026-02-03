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

// Process and enrich calls
function processAndEnrichCalls(calls, enrichmentMap) {
    return calls.map(call => {
        const enrichment = enrichmentMap.get(call.id);

        // Extract email and duration
        const email = extractEmail(call);
        let duration = call.duration || 0;
        if (!duration && call.startedAt && call.endedAt) {
            const start = new Date(call.startedAt);
            const end = new Date(call.endedAt);
            duration = (end - start) / 1000;
        }

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

        return {
            ...call,
            category,
            hangupType,
            transferReason,
            spamType,
            email,
            duration,
            phoneNumber: call.customer?.number || 'Unknown',
            customerName: call.customer?.name || 'Unknown'
        };
    });
}

// Calculate comprehensive metrics
function calculateMetrics(enrichedCalls) {
    const totalCalls = enrichedCalls.length;

    // Category counts
    const bookingCompleted = enrichedCalls.filter(c => c.category === 'booking-completed').length;
    const bookingAbandoned = enrichedCalls.filter(c => c.category === 'booking-abandoned').length;
    const bookingTransferred = enrichedCalls.filter(c => c.category === 'booking-transferred').length;
    const transferredCalls = enrichedCalls.filter(c => c.category === 'transferred');
    const transferred = transferredCalls.length;
    const spam = enrichedCalls.filter(c => c.category === 'spam').length;

    // Hangup breakdown
    const hangupHighValue = enrichedCalls.filter(c => c.category === 'hangup' && c.hangupType === 'high-value').length;
    const hangupModerate = enrichedCalls.filter(c => c.category === 'hangup' && c.hangupType === 'moderate').length;
    const hangupLowValue = enrichedCalls.filter(c => c.category === 'hangup' && c.hangupType === 'low-value').length;
    const hangupTotal = hangupHighValue + hangupModerate + hangupLowValue;

    // Transfer breakdown (dynamic by client config)
    const transferReasons = {};
    const configuredTransferReasons = Object.keys(config.client.transferReasons || {});
    if (configuredTransferReasons.length > 0) {
        configuredTransferReasons.forEach(reason => {
            transferReasons[reason] = 0;
        });
    }

    for (const call of transferredCalls) {
        const reasonRaw = call.transferReason || 'unspecified';
        const reason = String(reasonRaw).trim().toLowerCase() || 'unspecified';
        if (transferReasons[reason] === undefined) {
            transferReasons[reason] = 0;
        }
        transferReasons[reason] += 1;
    }

    // Metrics calculations
    const eligibleLeads = bookingCompleted + bookingAbandoned + bookingTransferred;
    const successRate = eligibleLeads > 0 ? Math.round((bookingCompleted / eligibleLeads) * 100) : 0;

    // Email capture
    const emailsCaptured = enrichedCalls.filter(c => c.email && c.email !== 'N/A').length;
    const emailCaptureRate = totalCalls > 0 ? Math.round((emailsCaptured / totalCalls) * 100) : 0;

    // Duration metrics
    const totalMinutes = enrichedCalls.reduce((sum, c) => sum + (c.duration || 0), 0) / 60;
    const callsWithDuration = enrichedCalls.filter(c => c.duration > 0);
    const avgDuration = callsWithDuration.length > 0
        ? Math.round(callsWithDuration.reduce((sum, c) => sum + c.duration, 0) / callsWithDuration.length)
        : 0;

    // Average duration by category
    const avgDurationByCategory = {};
    ['booking-completed', 'booking-abandoned', 'booking-transferred', 'transferred', 'spam', 'hangup'].forEach(cat => {
        const callsInCat = enrichedCalls.filter(c => c.category === cat && c.duration > 0);
        avgDurationByCategory[cat] = callsInCat.length > 0
            ? Math.round(callsInCat.reduce((sum, c) => sum + c.duration, 0) / callsInCat.length)
            : 0;
    });

    // Spam detection speed
    const spamCalls = enrichedCalls.filter(c => c.category === 'spam' && c.duration > 0);
    const avgSpamDuration = spamCalls.length > 0
        ? Math.round(spamCalls.reduce((sum, c) => sum + c.duration, 0) / spamCalls.length)
        : 0;

    // After-hours calls (outside business hours)
    const businessHours = config.client.businessHours || { start: 8, end: 17, days: [1, 2, 3, 4, 5] };
    const afterHoursCalls = enrichedCalls.filter(c => {
        if (!c.createdAt) return false;
        const callTime = toZonedTime(new Date(c.createdAt), TIME_ZONE);
        const hour = callTime.getHours();
        const day = callTime.getDay();
        return hour < businessHours.start || hour >= businessHours.end || !businessHours.days.includes(day);
    }).length;

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
        transferReasons,
        emailsCaptured,
        emailCaptureRate,
        totalMinutes,
        avgDuration,
        avgDurationByCategory,
        avgSpamDuration,
        afterHoursCalls
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
    const secs = seconds % 60;
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

    const prompt = `You are an executive reporting assistant analyzing ${aiName} (an AI phone assistant for ${config.client.name}) performance data.

Generate a concise executive summary (3-4 paragraphs) based on this week's performance:

**Week ${weekKey} Performance:**
- Total Calls: ${metrics.totalCalls}${previousMetrics ? ` (${metrics.totalCalls > previousMetrics.totalCalls ? '+' : ''}${metrics.totalCalls - previousMetrics.totalCalls} vs last week)` : ''}
- Booking Success Rate: ${metrics.successRate}%${previousMetrics ? ` (${metrics.successRate >= previousMetrics.successRate ? '+' : ''}${metrics.successRate - previousMetrics.successRate}% vs last week)` : ''}
- Eligible Leads: ${metrics.eligibleLeads}
- Booking Completed: ${metrics.bookingCompleted}
- Booking Abandoned: ${metrics.bookingAbandoned} (HIGH-VALUE RECOVERY OPPORTUNITY)
- High-Value Hangups: ${metrics.hangupHighValue} (CALLBACK PRIORITY)
- Email Capture Rate: ${metrics.emailCaptureRate}%
- Spam Detection: ${metrics.avgSpamDuration}s average
- After-Hours Calls: ${metrics.afterHoursCalls} (calls that would've been missed)

**IMPORTANT - Statistical Context:**
- Weeks with fewer than 20 total calls have lower statistical significance - temper analysis accordingly
- When comparing week-over-week, note if either week had <20 calls before drawing conclusions
- Avoid dramatic language (e.g., "100% success") for small sample sizes
- Include raw numbers with percentages where relevant (e.g., "80% (4/5)" not just "80%")

**Template Structure:**
1. **Performance Overview**: Highlight call volume, booking success rate trends, and key wins
2. **Revenue Impact**: Focus on eligible leads, bookings completed, and recovery opportunities (abandoned bookings + high-value hangups)
3. **Areas for Improvement**: Identify 2-3 specific issues (e.g., success rate decline, email capture gaps, transfer trends)
4. **Strategic Insights**: One actionable insight or pattern worth noting

Keep it executive-friendly: focus on business impact, not technical details. Use specific numbers.`;

    try {
        const response = await openai.chat.completions.create({
            model: 'gpt-5.1',
            messages: [{ role: 'user', content: prompt }],
            temperature: 0.7,
            max_tokens: 800
        });

        return response.choices[0].message.content.trim();
    } catch (error) {
        console.warn('Failed to generate AI summary:', error.message);
        return `**Week ${weekKey} Performance Overview**\n\n${aiName} handled ${metrics.totalCalls} calls this week${previousMetrics ? `, ${metrics.totalCalls > previousMetrics.totalCalls ? 'up' : 'down'} ${Math.abs(metrics.totalCalls - previousMetrics.totalCalls)} from last week` : ''}. Booking success rate was ${metrics.successRate}%, generating ${metrics.bookingCompleted} confirmed appointments.\n\n**Key Opportunities:** ${metrics.bookingAbandoned} booking abandonments and ${metrics.hangupHighValue} high-value hangups represent immediate follow-up opportunities.\n\n_(AI summary generation failed - using template)_`;
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

    // Generate heatmap
    console.log('Generating call volume heatmap...');
    const heatmapConfig = config.report.heatmap || { intervalMinutes: 30, showWeekends: true };
    const heatmap = generateHeatmap(enrichedCalls, heatmapConfig);
    const heatmapMarkdown = formatHeatmapAsMarkdown(heatmap, heatmapConfig);
    const peakHours = findPeakHours(heatmap, 5);

    // Generate Day of Week analysis
    console.log('Analyzing day of week patterns...');
    const dowAnalysis = analyzeDayOfWeek(enrichedCalls, heatmap);

    // Generate Week of Month analysis
    console.log('Analyzing week of month patterns...');
    const monthKey = weekKey.substring(0, 7); // Extract "2025-11" from "2025-W47"
    const womAnalysis = analyzeWeekOfMonth(enrichedCalls, monthKey);

    // Generate leads report
    console.log('Extracting high-priority leads...');
    const leadsReport = generateLeadsReport(enrichedCalls, weekKey, config.paths.reportsDir);

    // Calculate ROI
    console.log('Calculating ROI metrics...');
    const costComparison = compareAIvsHuman(metrics.totalMinutes, metrics.totalCalls, config.report.pricing);

    // Generate scorecard
    const scorecard = generateScorecard(metrics, previousMetrics, config.report.targets);

    // Generate executive summary
    console.log('Generating executive summary...');
    const executiveSummary = await generateExecutiveSummary(metrics, previousMetrics, weekKey);

    // Build Markdown Report
    const aiName = config.client.aiAssistantName;
    let md = `# ${aiName} Weekly Performance Report\n`;
    md += `## ${config.client.name} - Week ${weekKey}\n\n`;
    md += `**Report Generated:** ${new Date().toLocaleString('en-US', { timeZone: TIME_ZONE })}\n\n`;
    md += `---\n\n`;

    // Executive Summary
    md += `## Executive Summary\n\n`;
    md += executiveSummary;
    md += `\n\n---\n\n`;

    // Performance Scorecard
    md += `## Performance Scorecard\n\n`;
    md += `| KPI | This Week | Target | Change | Grade |\n`;
    md += `|-----|-----------|--------|--------|-------|\n`;
    for (const score of scorecard) {
        md += `| ${score.kpi} | ${score.value} | ${score.target} | ${score.change} | **${score.grade}** |\n`;
    }
    md += `\n**Overall Performance:** ${scorecard.filter(s => s.grade.startsWith('A')).length >= 3 ? 'A-' : 'B+'} (${scorecard.filter(s => s.grade.startsWith('A')).length} A's, ${scorecard.filter(s => s.grade.startsWith('B')).length} B's)\n\n`;
    md += `---\n\n`;

    // ROI Analysis
    md += `## ROI Analysis: ${aiName} vs Human Receptionist\n\n`;
    md += formatCostComparisonTable(costComparison);
    md += `\n**24/7 Availability Impact:**\n`;
    md += `- After-hours/weekend calls handled: ${metrics.afterHoursCalls} (${Math.round((metrics.afterHoursCalls / metrics.totalCalls) * 100)}%)\n`;
    md += `- These calls would have gone to voicemail without ${aiName}\n`;
    md += `- ${aiName} works 24/7, no PTO, handles unlimited concurrent calls\n\n`;
    md += `---\n\n`;

    // Call Volume Heatmap
    md += `## Call Volume Heatmap (${heatmapConfig.intervalMinutes}-Minute Intervals)\n\n`;
    md += heatmapMarkdown;
    md += `\n**Peak Hours:**\n`;
    for (let i = 0; i < peakHours.length; i++) {
        const peak = peakHours[i];
        md += `${i + 1}. ${peak.time} - ${peak.totalCount} calls (Peak day: ${peak.peakDay.toUpperCase()} with ${peak.peakDayCount} calls)\n`;
    }
    md += `\n---\n\n`;

    // Day of Week Analysis
    md += `## Day of Week Performance Analysis\n\n`;
    md += `| Day | Total Calls | % of Week | Eligible Leads | Success Rate | Avg Duration | Hangup (H/M/L) | Peak Hour |\n`;
    md += `|-----|-------------|-----------|----------------|--------------|--------------|----------------|----------|\n`;
    for (const day of dowAnalysis) {
        const hangupBreakdown = `${day.hangupHighValue}/${day.hangupModerate}/${day.hangupLowValue}`;
        md += `| ${day.dayName} | ${day.totalCalls} | ${day.percentOfWeek}% | ${day.eligibleLeads} | ${day.successRate}% | ${formatDuration(day.avgDuration)} | ${hangupBreakdown} | ${day.peakHour} |\n`;
    }

    // Find best/worst performing days
    const daysWithCalls = dowAnalysis.filter(d => d.totalCalls > 0);
    if (daysWithCalls.length > 0) {
        const bestDay = daysWithCalls.reduce((best, day) => day.successRate > best.successRate ? day : best);
        const highestVolume = daysWithCalls.reduce((max, day) => day.totalCalls > max.totalCalls ? day : max);
        const lowestVolume = daysWithCalls.reduce((min, day) => day.totalCalls < min.totalCalls ? day : min);

        md += `\n**Key Insights:**\n`;
        md += `- Best performing day: **${bestDay.dayName}** (${bestDay.successRate}% success rate)\n`;
        md += `- Highest volume: **${highestVolume.dayName}** (${highestVolume.totalCalls} calls)\n`;
        md += `- Lowest volume: **${lowestVolume.dayName}** (${lowestVolume.totalCalls} calls)\n`;
    }

    md += `\n---\n\n`;

    // Week of Month Analysis
    if (womAnalysis.length > 0) {
        md += `## Week of Month Patterns (Calendar Weeks)\n\n`;
        md += `| Week | Date Range | Calls | Eligible Leads | Success Rate | Avg Duration | Notes |\n`;
        md += `|------|------------|-------|----------------|--------------|--------------|-------|\n`;
        for (const week of womAnalysis) {
            md += `| Week ${week.weekNum} | ${week.dateRange} | ${week.totalCalls} | ${week.eligibleLeads} | ${week.successRate}% | ${formatDuration(week.avgDuration)} | ${week.notes} |\n`;
        }

        // Add insights
        if (womAnalysis.length > 1) {
            const bestWeek = womAnalysis.reduce((best, week) => week.totalCalls > best.totalCalls ? week : best);
            const worstWeek = womAnalysis.reduce((worst, week) => week.totalCalls < worst.totalCalls ? week : worst);

            md += `\n**Insights:**\n`;
            md += `- Week ${bestWeek.weekNum} had highest call volume (${bestWeek.totalCalls} calls)\n`;
            md += `- Week ${worstWeek.weekNum} had lowest call volume (${worstWeek.totalCalls} calls)\n`;

            // Check for end of month decline
            const lastWeek = womAnalysis[womAnalysis.length - 1];
            const secondToLastWeek = womAnalysis.length > 1 ? womAnalysis[womAnalysis.length - 2] : null;
            if (secondToLastWeek && lastWeek.totalCalls < secondToLastWeek.totalCalls) {
                const decline = Math.round(((secondToLastWeek.totalCalls - lastWeek.totalCalls) / secondToLastWeek.totalCalls) * 100);
                md += `- End of month decline: ${decline}% fewer calls in Week ${lastWeek.weekNum} vs Week ${secondToLastWeek.weekNum}\n`;
            }
        }

        md += `\n---\n\n`;
    }

    // Revenue Impact
    md += `## Revenue Impact\n\n`;
    md += `### Bookings Generated\n\n`;
    md += `| Metric | Count | % |\n`;
    md += `|--------|-------| - |\n`;
    md += `| Booking Completed | ${metrics.bookingCompleted} | ${Math.round((metrics.bookingCompleted / metrics.totalCalls) * 100)}% |\n`;
    md += `| Booking Abandoned | ${metrics.bookingAbandoned} | ${Math.round((metrics.bookingAbandoned / metrics.totalCalls) * 100)}% |\n`;
    md += `| Booking Transferred | ${metrics.bookingTransferred} | ${Math.round((metrics.bookingTransferred / metrics.totalCalls) * 100)}% |\n`;
    md += `| **Eligible Leads** | **${metrics.eligibleLeads}** | **${Math.round((metrics.eligibleLeads / metrics.totalCalls) * 100)}%** |\n`;
    md += `\n**Success Rate:** ${metrics.successRate}% (${metrics.bookingCompleted} bookings ÷ ${metrics.eligibleLeads} eligible leads)\n\n`;

    // High-Priority Leads
    md += leadsReport.summary;
    md += `\n### Lead Export\n`;
    md += `📊 **CSV Export:** [high_priority_leads_${weekKey}.csv](${path.basename(leadsReport.csvPath)})\n`;
    md += `- ${leadsReport.totalLeads} leads with phone numbers and emails for manual follow-up\n`;
    md += `- Sorted by priority (HIGH → MEDIUM)\n\n`;
    md += leadsReport.table;
    md += `\n---\n\n`;

    // Detailed Breakdowns
    md += `## Detailed Performance Breakdowns\n\n`;

    // Booking Outcomes
    md += `### Booking Outcomes Funnel\n\n`;
    md += `| Stage | Count | % of Total Calls | % of Eligible |\n`;
    md += `|-------|-------|------------------|---------------|\n`;
    md += `| Total Calls | ${metrics.totalCalls} | 100% | - |\n`;
    md += `| Eligible Leads | ${metrics.eligibleLeads} | ${Math.round((metrics.eligibleLeads / metrics.totalCalls) * 100)}% | 100% |\n`;
    md += `| └─ Booking Completed | ${metrics.bookingCompleted} | ${Math.round((metrics.bookingCompleted / metrics.totalCalls) * 100)}% | ${Math.round((metrics.bookingCompleted / metrics.eligibleLeads) * 100)}% |\n`;
    md += `| └─ Booking Abandoned | ${metrics.bookingAbandoned} | ${Math.round((metrics.bookingAbandoned / metrics.totalCalls) * 100)}% | ${Math.round((metrics.bookingAbandoned / metrics.eligibleLeads) * 100)}% |\n`;
    md += `| └─ Booking Transferred | ${metrics.bookingTransferred} | ${Math.round((metrics.bookingTransferred / metrics.totalCalls) * 100)}% | ${Math.round((metrics.bookingTransferred / metrics.eligibleLeads) * 100)}% |\n\n`;

    // Hangup Analysis
    md += `### Hangup Engagement Analysis\n\n`;
    md += `| Engagement Level | Count | % of Total Hangups | Follow-Up Priority |\n`;
    md += `|------------------|-------|-------------------|-------------------|\n`;
    md += `| High-Value | ${metrics.hangupHighValue} | ${metrics.hangupTotal > 0 ? Math.round((metrics.hangupHighValue / metrics.hangupTotal) * 100) : 0}% | 🔥 MEDIUM PRIORITY |\n`;
    md += `| Moderate | ${metrics.hangupModerate} | ${metrics.hangupTotal > 0 ? Math.round((metrics.hangupModerate / metrics.hangupTotal) * 100) : 0}% | ⚠️ LOW PRIORITY |\n`;
    md += `| Low-Value | ${metrics.hangupLowValue} | ${metrics.hangupTotal > 0 ? Math.round((metrics.hangupLowValue / metrics.hangupTotal) * 100) : 0}% | ✅ Skip Callbacks |\n`;
    md += `| **Total** | **${metrics.hangupTotal}** | **100%** | - |\n\n`;

    // Transfer Analysis
    md += `### Transfer Reason Analysis\n\n`;
    md += `| Reason | Count | % of Transfers | Notes |\n`;
    md += `|--------|-------|----------------|-------|\n`;
    const transferReasonCounts = metrics.transferReasons || {};
    const configuredReasons = Object.keys(config.client.transferReasons || {});
    const orderedReasons = configuredReasons.length > 0
        ? configuredReasons.filter(reason => transferReasonCounts[reason] !== undefined)
        : Object.keys(transferReasonCounts);
    const extraReasons = Object.keys(transferReasonCounts).filter(reason => !orderedReasons.includes(reason));
    const reasonList = [...orderedReasons, ...extraReasons];

    if (reasonList.length === 0) {
        md += `| _No transfer reasons recorded_ | 0 | 0% | - |\n`;
    } else {
        for (const reason of reasonList) {
            const count = transferReasonCounts[reason] || 0;
            const percent = metrics.transferred > 0 ? Math.round((count / metrics.transferred) * 100) : 0;
            md += `| ${formatTransferReasonLabel(reason)} | ${count} | ${percent}% | ${getTransferReasonNote(reason, config)} |\n`;
        }
    }
    md += `| **Total** | **${metrics.transferred}** | **100%** | - |\n\n`;

    // Efficiency Metrics
    md += `### Efficiency Metrics\n\n`;
    md += `**Average Call Duration by Outcome:**\n\n`;
    md += `| Outcome | Avg Duration | Notes |\n`;
    md += `|---------|--------------|-------|\n`;
    md += `| Booking Completed | ${formatDuration(metrics.avgDurationByCategory['booking-completed'])} | Optimal: 3-5 min |\n`;
    md += `| Booking Abandoned | ${formatDuration(metrics.avgDurationByCategory['booking-abandoned'])} | Compare to completed |\n`;
    md += `| Booking Transferred | ${formatDuration(metrics.avgDurationByCategory['booking-transferred'])} | - |\n`;
    md += `| Transferred | ${formatDuration(metrics.avgDurationByCategory['transferred'])} | - |\n`;
    md += `| Spam | ${formatDuration(metrics.avgDurationByCategory['spam'])} | Fast detection = cost savings |\n`;
    md += `| Hangup | ${formatDuration(metrics.avgDurationByCategory['hangup'])} | Quick qualification |\n\n`;

    // Add Week-over-Week duration commentary
    if (previousMetrics && previousMetrics.avgDurationByCategory) {
        md += `**Average Duration Changes (Week-over-Week):**\n`;

        const categories = [
            { key: 'booking-completed', label: 'Booking Completed' },
            { key: 'booking-abandoned', label: 'Booking Abandoned' },
            { key: 'spam', label: 'Spam Detection' },
            { key: 'transferred', label: 'Transfers' }
        ];

        for (const cat of categories) {
            const current = metrics.avgDurationByCategory[cat.key];
            const previous = previousMetrics.avgDurationByCategory[cat.key];

            if (current > 0 && previous > 0) {
                const diff = current - previous;
                const absDiff = Math.abs(diff);
                let arrow = '↔';
                let note = 'Stable performance';

                if (diff > 10) {
                    arrow = '↑';
                    if (cat.key === 'booking-abandoned') {
                        note = '⚠️ Taking longer, may indicate confusion or friction';
                    } else if (cat.key === 'spam') {
                        note = '⚠️ Slower detection';
                    } else {
                        note = 'Duration increased';
                    }
                } else if (diff < -10) {
                    arrow = '↓';
                    if (cat.key === 'booking-completed') {
                        note = '✅ Improved efficiency';
                    } else if (cat.key === 'spam') {
                        note = '✅ Faster identification';
                    } else {
                        note = '✅ Improved speed';
                    }
                }

                md += `- ${cat.label}: ${formatDuration(current)} (${arrow} ${absDiff}s from last week) - ${note}\n`;
            }
        }

        md += `\n**Key Insights:**\n`;

        // Overall trend
        const bookingDiff = metrics.avgDurationByCategory['booking-completed'] - previousMetrics.avgDurationByCategory['booking-completed'];
        if (bookingDiff < -10) {
            md += `- Overall call handling is becoming more efficient (${Math.abs(bookingDiff)}s faster on bookings)\n`;
        } else if (bookingDiff > 10) {
            md += `- Booking calls taking longer (${bookingDiff}s increase) - investigate for potential issues\n`;
        }

        // Abandoned bookings trend
        const abandonedDiff = metrics.avgDurationByCategory['booking-abandoned'] - previousMetrics.avgDurationByCategory['booking-abandoned'];
        if (abandonedDiff > 15) {
            md += `- Booking abandonment duration increased significantly (${abandonedDiff}s) - suggests possible friction in booking flow\n`;
        }

        md += `\n`;
    }

    md += `**Email Capture Quality:**\n`;
    md += `- Overall capture rate: ${metrics.emailCaptureRate}% (${metrics.emailsCaptured} of ${metrics.totalCalls} calls)\n`;
    md += `- Target: ${config.report.targets.emailCaptureRate}%\n\n`;

    md += `---\n\n`;

    // Revenue Placeholder Section
    md += `## Revenue Performance (Lagging Metrics)\n\n`;
    md += `_This section tracks conversion from bookings → visits → projects. Update config/revenue.json monthly._\n\n`;

    const monthData = revenueData[monthKey] || {};

    md += `### Month-to-Date Performance\n\n`;
    md += `| Month | Bookings (${aiName}) | Sales Visits | Visits → Projects | Avg Project Value | Total Revenue |\n`;
    md += `|-------|-----------------|--------------|-------------------|-------------------|---------------|\n`;

    if (monthData.bookingsGenerated !== null && monthData.bookingsGenerated !== undefined) {
        const visits = monthData.salesVisits || '_[pending]_';
        const projects = monthData.convertedVisits || '_[pending]_';
        const avgValue = monthData.avgProjectValue ? `$${monthData.avgProjectValue.toLocaleString()}` : '_[pending]_';
        const revenue = monthData.totalRevenue ? `$${monthData.totalRevenue.toLocaleString()}` : '_[pending]_';
        md += `| ${monthKey} | ${monthData.bookingsGenerated} | ${visits} | ${projects} | ${avgValue} | ${revenue} |\n`;
    } else {
        md += `| ${monthKey} | _[pending]_ | _[pending]_ | _[pending]_ | _[pending]_ | _[pending]_ |\n`;
    }

    md += `\n_**Note:** This data has a 30-60 day lag. Update config/revenue.json after month closes._\n\n`;

    md += `---\n\n`;

    // Key Metrics Definitions
    md += `## Appendix: Metrics Definitions\n\n`;
    md += `**Categories:**\n`;
    md += `- **booking-completed**: Customer successfully completed appointment booking\n`;
    md += `- **booking-abandoned**: Customer started booking but did not complete (HIGH-VALUE RECOVERY)\n`;
    md += `- **booking-transferred**: Booking attempt transferred to human\n`;
    md += `- **transferred**: Call transferred without booking attempt\n`;
    md += `- **spam**: Spam, robocalls, wrong numbers\n`;
    md += `- **hangup**: Customer hung up (categorized by engagement level)\n\n`;

    md += `**Key Formulas:**\n`;
    md += `- **Eligible Leads** = Booking Completed + Booking Abandoned + Booking Transferred\n`;
    md += `- **Success Rate** = (Booking Completed ÷ Eligible Leads) × 100%\n`;
    md += `- **Email Capture Rate** = (Emails Captured ÷ Total Calls) × 100%\n`;
    md += `- **ROI** = (Revenue - ${aiName} Cost) ÷ ${aiName} Cost × 100%\n\n`;

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

    console.log(`✅ CSV leads export saved: ${leadsReport.csvPath}`);
    console.log(`\n=== Weekly Report Complete ===`);
    console.log(`Week: ${weekKey}`);
    console.log(`Total Calls: ${metrics.totalCalls}`);
    console.log(`Eligible Leads: ${metrics.eligibleLeads}`);
    console.log(`Success Rate: ${metrics.successRate}%`);
    console.log(`High-Priority Leads: ${leadsReport.totalLeads}`);
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

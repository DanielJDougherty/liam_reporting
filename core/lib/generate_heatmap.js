const { parseISO, getDay, getHours, getMinutes, format } = require('date-fns');
const { toZonedTime } = require('date-fns-tz');

const TIME_ZONE = 'America/New_York';

/**
 * Generate call volume heatmap for 30-minute intervals
 * @param {Array} calls - Array of call objects with createdAt timestamps
 * @param {Object} options - Configuration options
 * @returns {Object} Heatmap data structure
 */
function generateHeatmap(calls, options = {}) {
    const intervalMinutes = options.intervalMinutes || 30;
    const showWeekends = options.showWeekends !== undefined ? options.showWeekends : true;

    // Initialize heatmap structure
    // Key: "HH:MM" (e.g., "08:00", "08:30")
    // Value: { mon: 0, tue: 0, wed: 0, thu: 0, fri: 0, sat: 0, sun: 0, total: 0 }
    const heatmap = {};

    // Generate all time slots (00:00 to 23:30 for 30-min intervals)
    const totalSlots = (24 * 60) / intervalMinutes;
    for (let i = 0; i < totalSlots; i++) {
        const totalMinutes = i * intervalMinutes;
        const hours = Math.floor(totalMinutes / 60);
        const mins = totalMinutes % 60;
        const timeKey = `${hours.toString().padStart(2, '0')}:${mins.toString().padStart(2, '0')}`;
        heatmap[timeKey] = {
            mon: 0,
            tue: 0,
            wed: 0,
            thu: 0,
            fri: 0,
            sat: 0,
            sun: 0,
            total: 0
        };
    }

    // Process each call
    for (const call of calls) {
        if (!call.createdAt) continue;

        // Convert to ET timezone
        const callTime = toZonedTime(new Date(call.createdAt), TIME_ZONE);
        const dayOfWeek = getDay(callTime); // 0=Sunday, 6=Saturday
        const hours = getHours(callTime);
        const minutes = getMinutes(callTime);

        // Round down to nearest interval
        const intervalIndex = Math.floor((hours * 60 + minutes) / intervalMinutes);
        const slotMinutes = intervalIndex * intervalMinutes;
        const slotHours = Math.floor(slotMinutes / 60);
        const slotMins = slotMinutes % 60;
        const timeKey = `${slotHours.toString().padStart(2, '0')}:${slotMins.toString().padStart(2, '0')}`;

        if (heatmap[timeKey]) {
            // Map day of week to day name
            const dayNames = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
            const dayName = dayNames[dayOfWeek];
            heatmap[timeKey][dayName]++;
            heatmap[timeKey].total++;
        }
    }

    return heatmap;
}

/**
 * Format heatmap as markdown table
 * @param {Object} heatmap - Heatmap data from generateHeatmap()
 * @param {Object} options - Formatting options
 * @returns {String} Markdown table string
 */
function formatHeatmapAsMarkdown(heatmap, options = {}) {
    const showWeekends = options.showWeekends !== undefined ? options.showWeekends : true;

    let md = '';

    // Header row
    if (showWeekends) {
        md += '| Time | Mon | Tue | Wed | Thu | Fri | Sat | Sun | Total |\n';
        md += '|------|-----|-----|-----|-----|-----|-----|-----|-------|\n';
    } else {
        md += '| Time | Mon | Tue | Wed | Thu | Fri | Total* |\n';
        md += '|------|-----|-----|-----|-----|-----|--------|\n';
    }

    // Sort time slots chronologically
    const sortedTimes = Object.keys(heatmap).sort();

    // Data rows
    for (const timeKey of sortedTimes) {
        const data = heatmap[timeKey];

        // Format time for display (e.g., "08:00 AM")
        const [hours, mins] = timeKey.split(':').map(Number);
        const period = hours >= 12 ? 'PM' : 'AM';
        const displayHours = hours === 0 ? 12 : hours > 12 ? hours - 12 : hours;
        const displayTime = `${displayHours}:${mins.toString().padStart(2, '0')} ${period}`;

        if (showWeekends) {
            md += `| ${displayTime} | ${data.mon} | ${data.tue} | ${data.wed} | ${data.thu} | ${data.fri} | ${data.sat} | ${data.sun} | ${data.total} |\n`;
        } else {
            const weekdayTotal = data.mon + data.tue + data.wed + data.thu + data.fri;
            md += `| ${displayTime} | ${data.mon} | ${data.tue} | ${data.wed} | ${data.thu} | ${data.fri} | ${weekdayTotal} |\n`;
        }
    }

    if (!showWeekends) {
        md += '\n*Total = Weekdays only (Mon-Fri)\n';
    }

    return md;
}

/**
 * Calculate peak hours from heatmap
 * @param {Object} heatmap - Heatmap data from generateHeatmap()
 * @param {Number} topN - Number of top time slots to return
 * @returns {Array} Array of {time, count, day} objects
 */
function findPeakHours(heatmap, topN = 5) {
    const peaks = [];

    for (const timeKey in heatmap) {
        const data = heatmap[timeKey];

        // Find peak day for this time slot
        const days = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
        let maxDay = 'mon';
        let maxCount = 0;

        for (const day of days) {
            if (data[day] > maxCount) {
                maxCount = data[day];
                maxDay = day;
            }
        }

        peaks.push({
            time: timeKey,
            totalCount: data.total,
            peakDay: maxDay,
            peakDayCount: maxCount
        });
    }

    // Sort by total count descending
    peaks.sort((a, b) => b.totalCount - a.totalCount);

    return peaks.slice(0, topN);
}

/**
 * Generate heatmap with metrics (e.g., success rate, eligible leads)
 * @param {Array} calls - Array of call objects with classification
 * @param {String} metric - Metric to track ('volume', 'eligible', 'bookings', 'successRate')
 * @param {Object} options - Configuration options
 * @returns {Object} Heatmap data structure
 */
function generateMetricHeatmap(calls, metric = 'volume', options = {}) {
    const intervalMinutes = options.intervalMinutes || 30;
    const heatmap = {};

    // Initialize heatmap
    const totalSlots = (24 * 60) / intervalMinutes;
    for (let i = 0; i < totalSlots; i++) {
        const totalMinutes = i * intervalMinutes;
        const hours = Math.floor(totalMinutes / 60);
        const mins = totalMinutes % 60;
        const timeKey = `${hours.toString().padStart(2, '0')}:${mins.toString().padStart(2, '0')}`;
        heatmap[timeKey] = {
            mon: { count: 0, metric: 0 },
            tue: { count: 0, metric: 0 },
            wed: { count: 0, metric: 0 },
            thu: { count: 0, metric: 0 },
            fri: { count: 0, metric: 0 },
            sat: { count: 0, metric: 0 },
            sun: { count: 0, metric: 0 }
        };
    }

    // Process calls
    for (const call of calls) {
        if (!call.createdAt) continue;

        const callTime = toZonedTime(new Date(call.createdAt), TIME_ZONE);
        const dayOfWeek = getDay(callTime);
        const hours = getHours(callTime);
        const minutes = getMinutes(callTime);

        const intervalIndex = Math.floor((hours * 60 + minutes) / intervalMinutes);
        const slotMinutes = intervalIndex * intervalMinutes;
        const slotHours = Math.floor(slotMinutes / 60);
        const slotMins = slotMinutes % 60;
        const timeKey = `${slotHours.toString().padStart(2, '0')}:${slotMins.toString().padStart(2, '0')}`;

        if (heatmap[timeKey]) {
            const dayNames = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
            const dayName = dayNames[dayOfWeek];

            heatmap[timeKey][dayName].count++;

            // Track specific metric
            if (metric === 'eligible') {
                if (['booking-completed', 'booking-abandoned', 'booking-transferred'].includes(call.category)) {
                    heatmap[timeKey][dayName].metric++;
                }
            } else if (metric === 'bookings') {
                if (call.category === 'booking-completed') {
                    heatmap[timeKey][dayName].metric++;
                }
            }
        }
    }

    return heatmap;
}

module.exports = {
    generateHeatmap,
    formatHeatmapAsMarkdown,
    findPeakHours,
    generateMetricHeatmap
};

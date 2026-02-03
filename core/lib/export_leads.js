/**
 * Lead Export Library for High-Priority Follow-Up
 */

const fs = require('fs');
const path = require('path');

/**
 * Extract high-priority leads for manual follow-up
 * @param {Array} calls - Array of call objects with classification and enrichment data
 * @returns {Object} Categorized leads
 */
function extractHighPriorityLeads(calls) {
    const leads = {
        bookingAbandoned: [],
        highValueHangups: [],
        newProjectTransfers: [],
        all: []
    };

    for (const call of calls) {
        const lead = {
            callId: call.id,
            date: call.createdAt ? new Date(call.createdAt).toLocaleDateString('en-US') : 'Unknown',
            time: call.createdAt ? new Date(call.createdAt).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }) : 'Unknown',
            phoneNumber: call.customer?.number || call.phoneNumber || 'N/A',
            customerName: call.customer?.name || 'Unknown',
            email: call.email || 'N/A',
            category: call.category || 'unknown',
            subcategory: call.hangupType || call.transferReason || call.spamType || 'N/A',
            duration: call.duration || 0,
            summary: call.summary || 'No summary available',
            priority: 'MEDIUM'
        };

        // Booking Abandoned - HIGHEST PRIORITY
        if (call.category === 'booking-abandoned') {
            lead.priority = 'HIGH';
            lead.reason = 'Customer started booking but did not complete';
            leads.bookingAbandoned.push(lead);
            leads.all.push(lead);
        }

        // High-Value Hangups - MEDIUM PRIORITY
        else if (call.category === 'hangup' && call.hangupType === 'high-value') {
            lead.priority = 'MEDIUM';
            lead.reason = 'Customer showed strong intent but hung up';
            leads.highValueHangups.push(lead);
            leads.all.push(lead);
        }

        // New Project Transfers - HIGH PRIORITY (new business)
        else if (call.category === 'transferred' && call.transferReason === 'new-project') {
            lead.priority = 'HIGH';
            lead.reason = 'New project inquiry transferred to team';
            leads.newProjectTransfers.push(lead);
            leads.all.push(lead);
        }
    }

    // Sort all leads by priority (HIGH first)
    leads.all.sort((a, b) => {
        const priorityOrder = { 'HIGH': 0, 'MEDIUM': 1, 'LOW': 2 };
        return priorityOrder[a.priority] - priorityOrder[b.priority];
    });

    return leads;
}

/**
 * Format duration in seconds to MM:SS
 * @param {Number} seconds - Duration in seconds
 * @returns {String} Formatted duration
 */
function formatDuration(seconds) {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, '0')}`;
}

/**
 * Export leads to CSV
 * @param {Object} leads - Result from extractHighPriorityLeads()
 * @param {String} outputPath - Path to save CSV file
 * @returns {String} Path to saved file
 */
function exportLeadsToCSV(leads, outputPath) {
    const rows = [];

    // CSV Header
    rows.push([
        'Priority',
        'Category',
        'Date',
        'Time',
        'Phone Number',
        'Customer Name',
        'Email',
        'Duration',
        'Reason',
        'Summary',
        'Call ID'
    ]);

    // Data rows
    for (const lead of leads.all) {
        rows.push([
            lead.priority,
            lead.category,
            lead.date,
            lead.time,
            lead.phoneNumber,
            lead.customerName,
            lead.email,
            formatDuration(lead.duration),
            lead.reason || '',
            lead.summary.replace(/"/g, '""'), // Escape quotes
            lead.callId
        ]);
    }

    // Convert to CSV string
    const csvContent = rows.map(row =>
        row.map(field => `"${field}"`).join(',')
    ).join('\n');

    // Ensure directory exists
    const dir = path.dirname(outputPath);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }

    // Write to file
    fs.writeFileSync(outputPath, csvContent, 'utf8');

    return outputPath;
}

/**
 * Format leads summary as markdown
 * @param {Object} leads - Result from extractHighPriorityLeads()
 * @returns {String} Markdown string
 */
function formatLeadsSummary(leads) {
    const total = leads.all.length;

    let md = '## High-Priority Leads for Manual Follow-Up\n\n';

    if (total === 0) {
        md += '_No high-priority leads this period._\n\n';
        return md;
    }

    md += `**Total Revenue Opportunities: ${total} calls**\n\n`;

    // Breakdown by category
    md += '### Lead Breakdown\n\n';
    md += `1. **Booking Abandoned**: ${leads.bookingAbandoned.length} calls (${Math.round((leads.bookingAbandoned.length / total) * 100)}%) ← HIGHEST PRIORITY\n`;
    md += `   - Already engaged, just didn't complete\n`;
    const abandonedWithEmail = leads.bookingAbandoned.filter(l => l.email && l.email !== 'N/A').length;
    md += `   - Email captured on ${abandonedWithEmail} (${Math.round((abandonedWithEmail / Math.max(leads.bookingAbandoned.length, 1)) * 100)}%)\n\n`;

    md += `2. **High-Value Hangups**: ${leads.highValueHangups.length} calls (${Math.round((leads.highValueHangups.length / total) * 100)}%) ← MEDIUM PRIORITY\n`;
    md += `   - Showed strong intent but didn't convert\n`;
    const hangupWithEmail = leads.highValueHangups.filter(l => l.email && l.email !== 'N/A').length;
    md += `   - Email captured on ${hangupWithEmail} (${Math.round((hangupWithEmail / Math.max(leads.highValueHangups.length, 1)) * 100)}%)\n\n`;

    md += `3. **New Project Transfers**: ${leads.newProjectTransfers.length} calls (${Math.round((leads.newProjectTransfers.length / total) * 100)}%) ← NEW BUSINESS\n`;
    md += `   - Sales opportunities outside AI scope\n`;
    md += `   - All transferred to team\n\n`;

    return md;
}

/**
 * Format leads as detailed markdown table
 * @param {Object} leads - Result from extractHighPriorityLeads()
 * @param {Number} limit - Maximum number of leads to display (default: 20)
 * @returns {String} Markdown table
 */
function formatLeadsTable(leads, limit = 20) {
    if (leads.all.length === 0) {
        return '_No leads to display._\n';
    }

    let md = '| Priority | Category | Date | Phone | Email | Duration | Reason |\n';
    md += '|----------|----------|------|-------|-------|----------|--------|\n';

    const displayLeads = leads.all.slice(0, limit);

    for (const lead of displayLeads) {
        const phone = lead.phoneNumber.length > 12 ? lead.phoneNumber.substring(0, 12) + '...' : lead.phoneNumber;
        const email = lead.email && lead.email !== 'N/A' ? lead.email : '-';
        const priority = lead.priority === 'HIGH' ? '🔥 HIGH' : '⚠️ MEDIUM';

        md += `| ${priority} | ${lead.category} | ${lead.date} | ${phone} | ${email} | ${formatDuration(lead.duration)} | ${lead.reason} |\n`;
    }

    if (leads.all.length > limit) {
        md += `\n_Showing ${limit} of ${leads.all.length} leads. See CSV export for complete list._\n`;
    }

    return md;
}

/**
 * Generate complete leads report
 * @param {Array} calls - Array of call objects
 * @param {String} weekKey - Week identifier (e.g., "2025-W47")
 * @param {String} reportsDir - Directory to save reports
 * @returns {Object} Report paths and summary
 */
function generateLeadsReport(calls, weekKey, reportsDir) {
    const leads = extractHighPriorityLeads(calls);

    // Generate CSV
    const csvPath = path.join(reportsDir, `high_priority_leads_${weekKey}.csv`);
    exportLeadsToCSV(leads, csvPath);

    // Generate markdown summary
    const summary = formatLeadsSummary(leads);
    const table = formatLeadsTable(leads, 20);

    return {
        leads: leads,
        csvPath: csvPath,
        summary: summary,
        table: table,
        totalLeads: leads.all.length
    };
}

module.exports = {
    extractHighPriorityLeads,
    exportLeadsToCSV,
    formatLeadsSummary,
    formatLeadsTable,
    formatDuration,
    generateLeadsReport
};

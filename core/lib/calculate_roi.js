/**
 * ROI Calculation Library for AI Assistant Performance Analysis
 */

/**
 * Calculate AI assistant operating costs
 * @param {Number} totalMinutes - Total connected minutes
 * @param {Number} costPerMinute - Cost per connected minute (default: $0.79)
 * @returns {Object} Cost breakdown
 */
function calculateAICost(totalMinutes, costPerMinute = 0.79) {
    const totalCost = totalMinutes * costPerMinute;
    const totalHours = totalMinutes / 60;

    return {
        totalMinutes: Math.round(totalMinutes * 100) / 100,
        totalHours: Math.round(totalHours * 100) / 100,
        costPerMinute: costPerMinute,
        totalCost: Math.round(totalCost * 100) / 100,
        costPerCall: 0 // Will be calculated when call count is provided
    };
}

/**
 * Calculate human receptionist equivalent cost
 * @param {Number} totalHours - Total hours of calls handled
 * @param {Number} hourlyRate - Human hourly rate (default: $45)
 * @param {Number} benefitsMultiplier - Benefits multiplier (default: 1.3 for 30% overhead)
 * @returns {Object} Cost breakdown
 */
function calculateHumanCost(totalHours, hourlyRate = 45, benefitsMultiplier = 1.3) {
    const baseCost = totalHours * hourlyRate;
    const fullyLoadedRate = hourlyRate * benefitsMultiplier;
    const totalCost = totalHours * fullyLoadedRate;

    return {
        totalHours: Math.round(totalHours * 100) / 100,
        hourlyRate: hourlyRate,
        benefitsMultiplier: benefitsMultiplier,
        fullyLoadedRate: Math.round(fullyLoadedRate * 100) / 100,
        baseCost: Math.round(baseCost * 100) / 100,
        totalCost: Math.round(totalCost * 100) / 100
    };
}

/**
 * Compare AI assistant cost vs Human cost
 * @param {Number} totalMinutes - Total connected minutes
 * @param {Number} totalCalls - Total number of calls
 * @param {Object} config - Configuration with pricing
 * @returns {Object} Comparison data
 */
function compareAIvsHuman(totalMinutes, totalCalls, config = {}) {
    const aiCostPerMin = config.aiCostPerMinute || config.blakeCostPerMinute || 0.79;
    const humanHourlyRate = config.humanHourlyRate || 45;
    const benefitsMultiplier = config.humanBenefitsMultiplier || 1.3;

    const ai = calculateAICost(totalMinutes, aiCostPerMin);
    ai.costPerCall = totalCalls > 0 ? Math.round((ai.totalCost / totalCalls) * 100) / 100 : 0;

    const human = calculateHumanCost(ai.totalHours, humanHourlyRate, benefitsMultiplier);

    const difference = ai.totalCost - human.totalCost;
    const percentDifference = human.totalCost > 0
        ? Math.round((difference / human.totalCost) * 100)
        : 0;

    return {
        ai: ai,
        human: human,
        difference: Math.round(difference * 100) / 100,
        percentDifference: percentDifference,
        isCheaper: difference < 0,
        savings: difference < 0 ? Math.abs(difference) : 0,
        additionalCost: difference > 0 ? difference : 0
    };
}

/**
 * Format cost comparison as markdown table
 * @param {Object} comparison - Result from compareAIvsHuman()
 * @returns {String} Markdown table
 */
function formatCostComparisonTable(comparison) {
    const ai = comparison.ai || comparison.blake; // Support legacy data
    let md = '| Metric | AI Assistant | Human Equivalent | Difference |\n';
    md += '|--------|--------------|------------------|------------|\n';
    md += `| Total Hours | ${ai.totalHours} hrs | ${comparison.human.totalHours} hrs | - |\n`;
    md += `| Hourly Rate | $${ai.costPerMinute}/min | $${comparison.human.fullyLoadedRate}/hr* | - |\n`;
    md += `| Total Cost | $${ai.totalCost.toFixed(2)} | $${comparison.human.totalCost.toFixed(2)} | `;

    if (comparison.isCheaper) {
        md += `$${comparison.savings.toFixed(2)} saved ✅ |\n`;
    } else {
        md += `$${comparison.additionalCost.toFixed(2)} additional cost ⚠️ |\n`;
    }

    md += `| Cost per Call | $${ai.costPerCall.toFixed(2)} | - | - |\n`;

    md += '\n*Includes benefits multiplier of ' + comparison.human.benefitsMultiplier + 'x\n';

    return md;
}

/**
 * Calculate estimated revenue from bookings (placeholder-based)
 * @param {Object} bookingMetrics - Booking counts
 * @param {Object} revenueData - Revenue conversion data (from revenue_data.json)
 * @returns {Object} Revenue estimates
 */
function estimateRevenue(bookingMetrics, revenueData = {}) {
    const bookingToVisitRate = revenueData.bookingToVisitRate || null;
    const visitToCloseRate = revenueData.visitToCloseRate || null;
    const avgProjectValue = revenueData.avgProjectValue || null;

    const estimates = {
        bookingsGenerated: bookingMetrics.bookingCompleted || 0,
        estimatedVisits: null,
        estimatedProjects: null,
        estimatedRevenue: null,
        hasData: false
    };

    if (bookingToVisitRate !== null && visitToCloseRate !== null && avgProjectValue !== null) {
        estimates.estimatedVisits = Math.round(estimates.bookingsGenerated * (bookingToVisitRate / 100));
        estimates.estimatedProjects = Math.round(estimates.estimatedVisits * (visitToCloseRate / 100));
        estimates.estimatedRevenue = Math.round(estimates.estimatedProjects * avgProjectValue);
        estimates.hasData = true;
    }

    return estimates;
}

/**
 * Format revenue estimate as markdown
 * @param {Object} estimates - Result from estimateRevenue()
 * @returns {String} Markdown string
 */
function formatRevenueEstimate(estimates) {
    let md = '| Metric | Count | Estimated Value |\n';
    md += '|--------|-------|----------------|\n';
    md += `| Bookings Generated | ${estimates.bookingsGenerated} | - |\n`;

    if (estimates.hasData) {
        md += `| Estimated Visits | ${estimates.estimatedVisits} | - |\n`;
        md += `| Estimated Projects | ${estimates.estimatedProjects} | - |\n`;
        md += `| **Estimated Revenue** | - | **$${estimates.estimatedRevenue.toLocaleString()}** |\n`;
    } else {
        md += `| Estimated Visits | - | _[Update revenue_data.json]_ |\n`;
        md += `| Estimated Projects | - | _[Update revenue_data.json]_ |\n`;
        md += `| **Estimated Revenue** | - | _[Update revenue_data.json]_ |\n`;
    }

    return md;
}

/**
 * Calculate ROI percentage
 * @param {Number} revenue - Total revenue generated
 * @param {Number} cost - Total cost (AI assistant operating cost)
 * @returns {Object} ROI metrics
 */
function calculateROI(revenue, cost) {
    if (cost === 0) {
        return { roi: 0, profit: 0, hasData: false };
    }

    const profit = revenue - cost;
    const roi = Math.round((profit / cost) * 100);

    return {
        revenue: Math.round(revenue * 100) / 100,
        cost: Math.round(cost * 100) / 100,
        profit: Math.round(profit * 100) / 100,
        roi: roi,
        hasData: revenue > 0
    };
}

/**
 * Format ROI as markdown
 * @param {Object} roi - Result from calculateROI()
 * @returns {String} Markdown string
 */
function formatROI(roi) {
    if (!roi.hasData) {
        return '_ROI calculation requires revenue data. Update revenue_data.json with conversion metrics._\n';
    }

    let md = '| Metric | Amount |\n';
    md += '|--------|--------|\n';
    md += `| Total Revenue | $${roi.revenue.toLocaleString()} |\n`;
    md += `| AI Assistant Cost | $${roi.cost.toLocaleString()} |\n`;
    md += `| Net Profit | $${roi.profit.toLocaleString()} |\n`;
    md += `| **ROI** | **${roi.roi}%** |\n`;

    return md;
}

module.exports = {
    calculateAICost,
    calculateHumanCost,
    compareAIvsHuman,
    formatCostComparisonTable,
    estimateRevenue,
    formatRevenueEstimate,
    calculateROI,
    formatROI,
    // Legacy aliases for backward compatibility
    calculateBlakeCost: calculateAICost,
    compareBlakeVsHuman: compareAIvsHuman
};

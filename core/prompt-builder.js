/**
 * Prompt Builder - Build GPT prompts from templates with client data
 *
 * Supports template placeholders:
 *   {{client.name}}
 *   {{client.aiAssistantName}}
 *   {{client.industry}}
 *   {{client.description}}
 *   {{client.timezone}}
 *   etc.
 */

/**
 * Build a prompt from a template string
 * @param {String} template - Template string with {{placeholders}}
 * @param {Object} config - Client configuration object
 * @returns {String} Processed prompt string
 */
function buildPrompt(template, config) {
    if (!template) return '';
    if (typeof template !== 'string') return String(template);

    let result = template;

    // Replace client placeholders
    result = replacePlaceholders(result, config.client, 'client');

    // Replace report placeholders
    if (config.report) {
        result = replacePlaceholders(result, config.report.pricing, 'pricing');
        result = replacePlaceholders(result, config.report.targets, 'targets');
    }

    return result;
}

/**
 * Build enrichment prompt for call classification
 * @param {Object} config - Client configuration
 * @returns {String} Complete enrichment prompt
 */
function buildEnrichmentPrompt(config) {
    const prompts = config.prompts.enrichment;

    let systemPrompt = buildPrompt(prompts.systemPrompt, config);
    let userPrompt = buildPrompt(prompts.userPrompt, config);

    // Build services list
    if (config.client.services && config.client.services.length > 0) {
        const servicesList = config.client.services.map(s => `- ${s}`).join('\n');
        userPrompt = userPrompt.replace('{{servicesList}}', servicesList);
    }

    // Build call purposes list
    if (config.client.callPurposes && config.client.callPurposes.length > 0) {
        const purposesList = config.client.callPurposes.map((p, i) => `${i + 1}. ${p}`).join('\n');
        userPrompt = userPrompt.replace('{{callPurposesList}}', purposesList);
    }

    // Build transfer reasons
    if (config.client.transferReasons) {
        const reasonsList = Object.entries(config.client.transferReasons)
            .map(([key, desc]) => `  - **${key}**: ${desc}`)
            .join('\n');
        userPrompt = userPrompt.replace('{{transferReasonsList}}', reasonsList);
    }

    // Build service keywords list (quoted, comma-separated for GPT context)
    if (config.client.serviceKeywords && config.client.serviceKeywords.length > 0) {
        const keywordsList = config.client.serviceKeywords.map(k => `"${k}"`).join(', ');
        userPrompt = userPrompt.replace('{{serviceKeywordsList}}', keywordsList);
    }

    // Build lead criteria list
    if (config.client.leadCriteria && config.client.leadCriteria.length > 0) {
        const criteriaList = config.client.leadCriteria.map(c => `- ${c}`).join('\n');
        userPrompt = userPrompt.replace('{{leadCriteriaList}}', criteriaList);
    }

    return {
        system: systemPrompt,
        user: userPrompt
    };
}

/**
 * Build hangup analysis prompt
 * @param {Object} config - Client configuration
 * @returns {String} Complete hangup analysis prompt
 */
function buildHangupAnalysisPrompt(config) {
    const prompts = config.prompts.hangupAnalysis;

    let systemPrompt = buildPrompt(prompts.systemPrompt, config);
    let userPrompt = buildPrompt(prompts.userPrompt || '', config);

    // Build qualification criteria
    if (prompts.qualificationCriteria && Array.isArray(prompts.qualificationCriteria)) {
        const criteriaList = prompts.qualificationCriteria.map(c => `- ${buildPrompt(c, config)}`).join('\n');
        userPrompt = userPrompt.replace('{{qualificationCriteria}}', criteriaList);
    }

    return {
        system: systemPrompt,
        user: userPrompt
    };
}

/**
 * Build report generation prompt
 * @param {Object} config - Client configuration
 * @param {String} reportType - Type of report ('executive', 'intraday', etc.)
 * @returns {String} Report generation prompt
 */
function buildReportPrompt(config, reportType = 'executive') {
    const prompts = config.prompts.reportGeneration || {};
    const template = prompts[reportType] || prompts.executiveSummary || '';

    return buildPrompt(template, config);
}

/**
 * Replace placeholders in a string with values from an object
 * @param {String} str - String with placeholders
 * @param {Object} data - Data object
 * @param {String} prefix - Prefix for placeholders (e.g., 'client')
 * @returns {String} String with replaced values
 */
function replacePlaceholders(str, data, prefix) {
    if (!data || typeof data !== 'object') return str;

    for (const [key, value] of Object.entries(data)) {
        const placeholder = new RegExp(`\\{\\{${prefix}\\.${key}\\}\\}`, 'g');

        if (typeof value === 'string' || typeof value === 'number') {
            str = str.replace(placeholder, value);
        } else if (Array.isArray(value)) {
            // For arrays, join with newlines
            str = str.replace(placeholder, value.join('\n'));
        } else if (typeof value === 'object' && value !== null) {
            // For nested objects, recursively replace
            str = replacePlaceholders(str, value, `${prefix}.${key}`);
        }
    }

    return str;
}

/**
 * Build complete context string for GPT prompts
 * @param {Object} config - Client configuration
 * @returns {String} Complete business context
 */
function buildBusinessContext(config) {
    const client = config.client;

    let context = `**BUSINESS CONTEXT:**\n`;
    context += `${client.name} is ${client.description}\n\n`;

    if (client.services && client.services.length > 0) {
        context += `**Services:**\n`;
        client.services.forEach(service => {
            context += `- ${service}\n`;
        });
        context += `\n`;
    }

    context += `${client.aiAssistantName} (AI assistant) handles inbound calls to:\n`;
    if (client.callPurposes && client.callPurposes.length > 0) {
        client.callPurposes.forEach((purpose, i) => {
            context += `${i + 1}. ${purpose}\n`;
        });
    }

    return context;
}

module.exports = {
    buildPrompt,
    buildEnrichmentPrompt,
    buildHangupAnalysisPrompt,
    buildReportPrompt,
    buildBusinessContext
};

const fs = require('fs');
const path = require('path');

const OPENAI_ANALYSIS_DIR = path.join(__dirname, '..', 'data', 'openai_analysis');
const METADATA_FILE = path.join(__dirname, '..', 'data', 'metadata.json');

/**
 * DATA ARCHITECTURE CONTEXT:
 *
 * This module is part of TIER 2 of the two-tier data architecture:
 *
 * TIER 1 (lib/store_enrichment.js):
 *   - Lightweight call classification for ALL calls
 *   - Fast, cheap categorization (booking/transfer/hangup/spam)
 *   - Stored in data/enriched/
 *
 * TIER 2 (lib/store_openai_analysis.js):
 *   - Deep qualitative analysis for TRUE HANGUPS only
 *   - Expensive, detailed lead qualification
 *   - Stored in data/openai_analysis/
 *
 * DEPENDENCY: Tier 2 analysis DEPENDS ON Tier 1 enrichments for call categorization.
 * analyze_hangups.js uses enrichments to filter down to true hangups before deep analysis.
 */

/**
 * Load all OpenAI analyses from the openai_analysis directory
 * Returns a Map of callId -> analysis data
 */
function loadAllAnalyses() {
  const analysisMap = new Map();

  if (!fs.existsSync(OPENAI_ANALYSIS_DIR)) {
    return analysisMap;
  }

  const files = fs.readdirSync(OPENAI_ANALYSIS_DIR)
    .filter(f => f.endsWith('.json'));

  files.forEach(filename => {
    try {
      const filepath = path.join(OPENAI_ANALYSIS_DIR, filename);
      const data = JSON.parse(fs.readFileSync(filepath, 'utf-8'));

      // Handle array format (current structure)
      if (Array.isArray(data)) {
        data.forEach(item => {
          if (item.callId && item.analysis) {
            analysisMap.set(item.callId, item);
          }
        });
      }
    } catch (error) {
      console.warn(`Warning: Could not load ${filename}: ${error.message}`);
    }
  });

  console.log(`Loaded ${analysisMap.size} OpenAI analyses from ${files.length} files.`);
  return analysisMap;
}

/**
 * Save OpenAI analyses to date range file
 * @param {Array} analyses - Array of {callId, createdAt, analysis, ...}
 * @param {string} dateRange - Date range string (e.g., "2025-11-08_to_2025-11-22")
 * @param {string} model - Model used for analysis (e.g., "gpt-5.1")
 */
function saveAnalyses(analyses, dateRange, model = 'gpt-5.1') {
  if (!fs.existsSync(OPENAI_ANALYSIS_DIR)) {
    fs.mkdirSync(OPENAI_ANALYSIS_DIR, { recursive: true });
  }

  const filename = `hangup_analysis_${dateRange}.json`;
  const filepath = path.join(OPENAI_ANALYSIS_DIR, filename);

  // Ensure all analyses have model field
  const enrichedAnalyses = analyses.map(a => ({
    ...a,
    model: a.model || model
  }));

  fs.writeFileSync(filepath, JSON.stringify(enrichedAnalyses, null, 2));
  console.log(`Saved ${enrichedAnalyses.length} analyses to ${filepath}`);

  // Update metadata
  updateAnalysisMetadata(enrichedAnalyses.length);

  return filepath;
}

/**
 * Save dataset insights from collective hangup analysis
 * @param {Object} insights - Dataset-level insights (commonHangupReasons, systemicPatterns, etc.)
 * @param {string} dateRange - Date range string
 */
function saveDatasetInsights(insights, dateRange) {
  if (!fs.existsSync(OPENAI_ANALYSIS_DIR)) {
    fs.mkdirSync(OPENAI_ANALYSIS_DIR, { recursive: true });
  }

  const filename = `hangup_dataset_insights_${dateRange}.json`;
  const filepath = path.join(OPENAI_ANALYSIS_DIR, filename);

  const data = {
    ...insights,
    generatedAt: new Date().toISOString(),
    dateRange
  };

  fs.writeFileSync(filepath, JSON.stringify(data, null, 2));
  console.log(`Saved dataset insights to ${filepath}`);

  return filepath;
}

/**
 * Update metadata with analysis stats
 */
function updateAnalysisMetadata(newAnalysisCount) {
  if (!fs.existsSync(METADATA_FILE)) {
    return;
  }

  const metadata = JSON.parse(fs.readFileSync(METADATA_FILE, 'utf-8'));
  metadata.lastHangupAnalysisTimestamp = new Date().toISOString();
  metadata.totalHangupAnalyses = (metadata.totalHangupAnalyses || 0) + newAnalysisCount;

  fs.writeFileSync(METADATA_FILE, JSON.stringify(metadata, null, 2));
}

/**
 * Get calls that haven't been analyzed yet
 * @param {Array} calls - Array of call objects with id
 * @param {Map} analysisMap - Map of callId -> analysis
 * @returns {Array} - Calls that need analysis
 */
function getUnanalyzedCalls(calls, analysisMap) {
  return calls.filter(call => !analysisMap.has(call.id));
}

module.exports = {
  loadAllAnalyses,
  saveAnalyses,
  saveDatasetInsights,
  getUnanalyzedCalls
};

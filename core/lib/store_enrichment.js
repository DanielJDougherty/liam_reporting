const fs = require('fs');
const path = require('path');
const { format } = require('date-fns');

/**
 * Load all enriched data from the enriched directory
 * Returns a Map of callId -> enrichment data
 * @param {string} enrichedDir - Path to enriched data directory
 */
function loadAllEnrichments(enrichedDir) {
  const enrichmentMap = new Map();

  if (!fs.existsSync(enrichedDir)) {
    return enrichmentMap;
  }

  const files = fs.readdirSync(enrichedDir)
    .filter(f => f.startsWith('vapi_enriched_') && f.endsWith('.json'));

  files.forEach(filename => {
    const filepath = path.join(enrichedDir, filename);
    const data = JSON.parse(fs.readFileSync(filepath, 'utf-8'));

    // Merge into the map
    Object.entries(data).forEach(([callId, enrichment]) => {
      enrichmentMap.set(callId, enrichment);
    });
  });

  console.log(`Existing enrichments: ${enrichmentMap.size}`);
  return enrichmentMap;
}

/**
 * Load enrichments for a specific date
 * @param {string} enrichedDir - Path to enriched data directory
 * @param {string} dateStr - Date string YYYY-MM-DD
 */
function loadEnrichmentsForDate(enrichedDir, dateStr) {
  const filename = path.join(enrichedDir, `vapi_enriched_${dateStr}.json`);

  if (!fs.existsSync(filename)) {
    return {};
  }

  return JSON.parse(fs.readFileSync(filename, 'utf-8'));
}

/**
 * Save enrichments to daily files based on call createdAt dates
 * @param {Array} enrichments - Array of {callId, createdAt, classification, ...}
 * @param {string} enrichedDir - Path to enriched data directory
 */
function saveEnrichments(enrichments, enrichedDir) {
  const enrichmentsByDate = {};
  const now = new Date().toISOString();

  enrichments.forEach(enrichment => {
    const { callId, createdAt } = enrichment;
    if (!createdAt) {
      console.warn(`Warning: Call ${callId} has no createdAt timestamp, skipping.`);
      return;
    }

    const dateKey = format(new Date(createdAt), 'yyyy-MM-dd');

    if (!enrichmentsByDate[dateKey]) {
      enrichmentsByDate[dateKey] = {};
    }

    // Store as object with callId as key
    enrichmentsByDate[dateKey][callId] = {
      callId,
      enrichedAt: now,
      ...enrichment
    };
  });

  // Save to daily files
  let totalSaved = 0;
  Object.entries(enrichmentsByDate).forEach(([dateKey, enrichmentData]) => {
    const filename = path.join(enrichedDir, `vapi_enriched_${dateKey}.json`);

    // Load existing enrichments if file exists
    let existingEnrichments = {};
    if (fs.existsSync(filename)) {
      existingEnrichments = JSON.parse(fs.readFileSync(filename, 'utf-8'));
    }

    // Merge (new enrichments overwrite old ones)
    const merged = { ...existingEnrichments, ...enrichmentData };

    fs.writeFileSync(filename, JSON.stringify(merged, null, 2));
    const newCount = Object.keys(enrichmentData).length;
    const totalCount = Object.keys(merged).length;
    console.log(`Saved ${newCount} enrichments to ${filename} (${totalCount} total)`);
    totalSaved += newCount;
  });

  return totalSaved;
}

/**
 * Get calls that haven't been enriched yet
 * @param {Array} calls - Array of call objects with id and createdAt
 * @param {Map} enrichmentMap - Map of callId -> enrichment
 * @returns {Array} - Calls that need enrichment
 */
function getUnenrichedCalls(calls, enrichmentMap) {
  return calls.filter(call => !enrichmentMap.has(call.id));
}

module.exports = {
  loadAllEnrichments,
  loadEnrichmentsForDate,
  saveEnrichments,
  getUnenrichedCalls
};

/**
 * Config Loader - Load and merge client configuration files
 *
 * Usage:
 *   const config = loadClientConfig('bathfitter');
 */

const fs = require('fs');
const path = require('path');

/**
 * Load all configuration files for a client
 * @param {String} clientName - Client folder name (e.g., 'bathfitter')
 * @param {String} baseDir - Optional base directory (defaults to parent of this file)
 * @returns {Object} Merged configuration object
 */
function loadClientConfig(clientName, baseDir = null) {
    if (!baseDir) {
        baseDir = path.join(__dirname, '..');
    }

    const clientDir = path.join(baseDir, 'clients', clientName);

    if (!fs.existsSync(clientDir)) {
        throw new Error(`Client directory not found: ${clientDir}`);
    }

    const configDir = path.join(clientDir, 'config');

    // Load all config files
    const config = {
        client: loadJSON(path.join(configDir, 'client.json')),
        prompts: loadJSON(path.join(configDir, 'prompts.json')),
        report: loadJSON(path.join(configDir, 'report.json')),
        revenue: loadJSON(path.join(configDir, 'revenue.json'))
    };

    // Add computed paths
    config.paths = {
        clientDir: clientDir,
        dataDir: path.join(clientDir, 'data'),
        rawDir: path.join(clientDir, 'data', 'raw'),
        enrichedDir: path.join(clientDir, 'data', 'enriched'),
        reportsDir: path.join(clientDir, 'data', 'reports'),
        openaiAnalysisDir: path.join(clientDir, 'data', 'openai_analysis'),
        recordingsDir: path.join(clientDir, 'data', 'recordings'),
        logsDir: path.join(clientDir, 'data', 'logs'),
        metadataFile: path.join(clientDir, 'data', 'metadata.json')
    };

    // Ensure data directories exist
    ensureDirectoryExists(config.paths.dataDir);
    ensureDirectoryExists(config.paths.rawDir);
    ensureDirectoryExists(config.paths.enrichedDir);
    ensureDirectoryExists(config.paths.reportsDir);
    ensureDirectoryExists(config.paths.openaiAnalysisDir);
    ensureDirectoryExists(config.paths.recordingsDir);
    ensureDirectoryExists(config.paths.logsDir);

    return config;
}

/**
 * Load JSON file with error handling
 * @param {String} filePath - Path to JSON file
 * @returns {Object} Parsed JSON object
 */
function loadJSON(filePath) {
    try {
        const content = fs.readFileSync(filePath, 'utf8');
        return JSON.parse(content);
    } catch (error) {
        throw new Error(`Failed to load config file ${filePath}: ${error.message}`);
    }
}

/**
 * Ensure directory exists, create if not
 * @param {String} dirPath - Directory path
 */
function ensureDirectoryExists(dirPath) {
    if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
    }
}

/**
 * Get list of available clients
 * @param {String} baseDir - Optional base directory
 * @returns {Array} Array of client names
 */
function getAvailableClients(baseDir = null) {
    if (!baseDir) {
        baseDir = path.join(__dirname, '..');
    }

    const clientsDir = path.join(baseDir, 'clients');

    if (!fs.existsSync(clientsDir)) {
        return [];
    }

    return fs.readdirSync(clientsDir).filter(name => {
        const clientPath = path.join(clientsDir, name);
        return fs.statSync(clientPath).isDirectory();
    });
}

module.exports = {
    loadClientConfig,
    getAvailableClients
};

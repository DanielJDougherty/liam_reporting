/**
 * Download Recordings - Generic script for any client
 *
 * Usage: node download-recordings.js --client=bathfitter [--date=2025-11-22] [--days=7] [--force]
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const https = require('https');
const { format } = require('date-fns');
const { toZonedTime } = require('date-fns-tz');
const { loadClientConfig } = require('../core/config-loader');

// Parse command line arguments
const args = process.argv.slice(2);
const clientArg = args.find(arg => arg.startsWith('--client='));
const dateArg = args.find(arg => arg.startsWith('--date='));
const daysArg = args.find(arg => arg.startsWith('--days='));
const forceRefresh = args.includes('--force');

if (!clientArg) {
    console.error('Error: --client argument is required');
    console.error('Usage: node download-recordings.js --client=<clientname> [--date=2025-11-22] [--days=7] [--force]');
    process.exit(1);
}

const clientName = clientArg.split('=')[1];
const date = dateArg ? dateArg.split('=')[1] : null;
const daysBack = daysArg ? parseInt(daysArg.split('=')[1]) : 7;

// Load client configuration
const config = loadClientConfig(clientName);
const TIME_ZONE = config.client.timezone || 'America/New_York';

console.log(`=== Downloading recordings for ${config.client.name} ===`);
console.log(`Timezone: ${TIME_ZONE}`);
console.log(`Date: ${date || `Last ${daysBack} days`}`);
console.log(`Force refresh: ${forceRefresh}`);

// Logger class
class Logger {
  constructor(logFilePath) {
    this.logFilePath = logFilePath;
    this.logStream = fs.createWriteStream(logFilePath, { flags: 'a' });
  }

  log(level, message) {
    const timestamp = new Date().toISOString();
    const logLine = `[${timestamp}] [${level}] ${message}\n`;

    // Write to file
    this.logStream.write(logLine);

    // Write to console
    if (level === 'ERROR') {
      console.error(logLine.trim());
    } else if (level === 'WARN') {
      console.warn(logLine.trim());
    } else {
      console.log(logLine.trim());
    }
  }

  info(message) { this.log('INFO', message); }
  warn(message) { this.log('WARN', message); }
  error(message) { this.log('ERROR', message); }

  close() {
    this.logStream.end();
  }
}

// Helper: Load metadata
function loadMetadata() {
  if (!fs.existsSync(config.paths.metadataFile)) {
    return {
      lastFetchTimestamp: null,
      lastFetchedCallId: null,
      totalCallsStored: 0,
      lastEnrichmentTimestamp: null,
      totalCallsEnriched: 0,
      lastRecordingDownload: null,
      recordingsDownloaded: 0,
      lastRecordingCallId: null
    };
  }
  return JSON.parse(fs.readFileSync(config.paths.metadataFile, 'utf-8'));
}

// Helper: Save metadata
function saveMetadata(metadata) {
  fs.writeFileSync(config.paths.metadataFile, JSON.stringify(metadata, null, 2));
}

// Helper: Clean phone number for filename
function cleanPhoneNumber(phoneNumber) {
  if (!phoneNumber) return 'Unknown';
  return phoneNumber.replace(/[^0-9]/g, '');
}

// Helper: Format duration for filename
function formatDuration(seconds) {
  if (!seconds || seconds === 0) return '0sec';

  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);

  const parts = [];
  if (hrs > 0) parts.push(`${hrs}hr`);
  if (mins > 0) parts.push(`${mins}min`);
  if (secs > 0 || parts.length === 0) parts.push(`${secs}sec`);

  return parts.join('-');
}

// Helper: Download file from URL
function downloadFile(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      if (res.statusCode !== 200) {
        reject(new Error(`Failed to download: HTTP ${res.statusCode}`));
        return;
      }

      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    }).on('error', reject);
  });
}

// Helper: Ensure local folder exists
function ensureLocalFolder(folderPath) {
  if (!fs.existsSync(folderPath)) {
    fs.mkdirSync(folderPath, { recursive: true });
  }
  return folderPath;
}

// Helper: Format folder name from date
function getFolderName(date) {
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  // Parse the date string
  const [year, month, day] = date.split('-').map(Number);
  const d = new Date(year, month - 1, day);

  const dayName = days[d.getDay()];
  const monthName = months[d.getMonth()];
  const dayNum = d.getDate();
  const yearNum = d.getFullYear();

  return `${dayName} ${monthName} ${dayNum} ${yearNum}`;
}

// Main function
async function downloadRecordings() {
  const logFileName = `recordings_${format(new Date(), 'yyyy-MM-dd_HH-mm-ss')}.log`;
  const logFilePath = path.join(config.paths.logsDir, logFileName);
  const logger = new Logger(logFilePath);

  try {
    logger.info('=== Local Recording Download Started ===');
    logger.info(`Client: ${config.client.name}`);
    logger.info(`Log file: ${logFilePath}`);
    logger.info(`Recordings will be saved to: ${config.paths.recordingsDir}`);

    const metadata = loadMetadata();

    // Determine which calls to process
    let callsToProcess = [];

    if (date) {
      // Specific date
      const dateFile = path.join(config.paths.rawDir, `vapi_calls_${date}.json`);
      if (!fs.existsSync(dateFile)) {
        logger.error(`No data file found for date: ${date}`);
        logger.close();
        return;
      }
      callsToProcess = JSON.parse(fs.readFileSync(dateFile, 'utf-8'));
      logger.info(`Loading calls from specific date: ${date}`);
    } else {
      // Load from multiple daily files based on daysBack
      const targetDate = new Date();
      for (let i = 0; i < daysBack; i++) {
        const dateStr = format(new Date(targetDate.getTime() - i * 24 * 60 * 60 * 1000), 'yyyy-MM-dd');
        const dateFile = path.join(config.paths.rawDir, `vapi_calls_${dateStr}.json`);

        if (fs.existsSync(dateFile)) {
          const calls = JSON.parse(fs.readFileSync(dateFile, 'utf-8'));
          callsToProcess = callsToProcess.concat(calls);
        }
      }
      logger.info(`Loading calls from last ${daysBack} days`);
    }

    logger.info(`Total calls loaded: ${callsToProcess.length}`);

    if (callsToProcess.length === 0) {
      logger.warn('No calls to process');
      logger.close();
      return;
    }

    // Filter calls with recording URLs
    const callsWithRecordings = callsToProcess.filter(c => c.stereoRecordingUrl);
    logger.info(`Calls with stereo recordings: ${callsWithRecordings.length}`);

    if (!forceRefresh && metadata.lastRecordingDownload) {
      const lastDownload = new Date(metadata.lastRecordingDownload);
      const newCalls = callsWithRecordings.filter(c => new Date(c.createdAt) > lastDownload);
      logger.info(`New recordings since last download: ${newCalls.length}`);

      if (newCalls.length === 0) {
        logger.info('No new recordings to download');
        logger.close();
        return;
      }
    }

    // Group calls by date
    const callsByDate = {};
    callsWithRecordings.forEach(call => {
      const zonedDate = toZonedTime(new Date(call.createdAt), TIME_ZONE);
      const dateKey = format(zonedDate, 'yyyy-MM-dd');
      if (!callsByDate[dateKey]) {
        callsByDate[dateKey] = [];
      }
      callsByDate[dateKey].push(call);
    });

    logger.info(`Processing ${Object.keys(callsByDate).length} date folders`);

    let totalDownloaded = 0;
    let totalFailed = 0;

    // Process each date
    for (const [dateKey, calls] of Object.entries(callsByDate)) {
      const folderName = getFolderName(dateKey);
      const folderPath = path.join(config.paths.recordingsDir, folderName);

      logger.info(`Processing folder: ${folderName} (${calls.length} recordings)`);

      try {
        // Ensure local folder exists
        ensureLocalFolder(folderPath);

        // Download and save each recording
        for (const call of calls) {
          const phoneNumber = cleanPhoneNumber(call.customer?.number);
          // Convert timestamp to client timezone
          const zonedTimestamp = toZonedTime(new Date(call.createdAt), TIME_ZONE);
          const timestamp = format(zonedTimestamp, 'yyyy-MM-dd_HH-mm-ss');

          // Calculate duration from start and end times
          let durationSeconds = 0;
          if (call.startedAt && call.endedAt) {
            durationSeconds = Math.floor((new Date(call.endedAt) - new Date(call.startedAt)) / 1000);
          }
          const duration = formatDuration(durationSeconds);

          const fileName = `${phoneNumber}_${timestamp}_${duration}.wav`;
          const filePath = path.join(folderPath, fileName);

          // Skip if file already exists (unless force refresh)
          if (!forceRefresh && fs.existsSync(filePath)) {
            logger.info(`Skipping (exists): ${fileName}`);
            continue;
          }

          try {
            logger.info(`Downloading: ${fileName}`);

            // Download the recording
            const recordingBuffer = await downloadFile(call.stereoRecordingUrl);

            logger.info(`  Size: ${(recordingBuffer.length / 1024 / 1024).toFixed(2)} MB`);
            logger.info(`  Saving to disk...`);

            // Save to local disk
            fs.writeFileSync(filePath, recordingBuffer);

            logger.info(`  ✓ Success: ${fileName}`);
            totalDownloaded++;

          } catch (error) {
            logger.error(`  ✗ Failed: ${fileName} - ${error.message}`);
            totalFailed++;
          }

          // Rate limiting - wait 500ms between downloads
          await new Promise(resolve => setTimeout(resolve, 500));
        }

      } catch (error) {
        logger.error(`Failed to process folder ${folderName}: ${error.message}`);
      }
    }

    // Update metadata
    if (callsWithRecordings.length > 0) {
      const latestCall = callsWithRecordings.reduce((latest, call) => {
        return new Date(call.createdAt) > new Date(latest.createdAt) ? call : latest;
      }, callsWithRecordings[0]);

      metadata.lastRecordingDownload = latestCall.createdAt;
      metadata.recordingsDownloaded = (metadata.recordingsDownloaded || 0) + totalDownloaded;
      metadata.lastRecordingCallId = latestCall.id;
      saveMetadata(metadata);
    }

    logger.info('\n=== Download Complete ===');
    logger.info(`Total recordings downloaded: ${totalDownloaded}`);
    logger.info(`Total failed: ${totalFailed}`);
    if (metadata.lastRecordingDownload) {
      logger.info(`Metadata updated: ${metadata.lastRecordingDownload}`);
    }
    logger.close();

  } catch (error) {
    logger.error(`Fatal error: ${error.message}`);
    logger.error(error.stack);
    logger.close();
    process.exit(1);
  }
}

// Run download
downloadRecordings();

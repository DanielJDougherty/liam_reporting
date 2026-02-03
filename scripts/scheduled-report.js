#!/usr/bin/env node
/**
 * Scheduled Report Orchestrator - Generic multi-client version
 *
 * Runs the full pipeline for scheduled report generation:
 * 1. Fetch latest data from Vapi
 * 2. Enrich with GPT classification
 * 3. Generate report (DOD or Intraday)
 * 4. Send email with branded report
 *
 * Usage:
 *   node scripts/scheduled-report.js --client=bathfitter --type=dod [--date=YYYY-MM-DD]
 *   node scripts/scheduled-report.js --client=bathfitter --type=intraday [--date=YYYY-MM-DD]
 *   node scripts/scheduled-report.js --client=bathfitter --test-email
 */

require('dotenv').config();
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { format, subDays } = require('date-fns');
const { loadClientConfig } = require('../core/config-loader');
const { sendReport, sendTestEmail } = require('../core/lib/email-sender');

/**
 * Run a command and log output
 */
function runCommand(description, command, cwd) {
    console.log(`\n=== ${description} ===`);
    console.log(`> ${command}`);
    try {
        execSync(command, {
            stdio: 'inherit',
            cwd: cwd,
            env: process.env
        });
        console.log(`[OK] ${description} completed`);
        return true;
    } catch (error) {
        console.error(`[FAIL] ${description} failed: ${error.message}`);
        return false;
    }
}

/**
 * Find the most recent report file matching a pattern in a directory
 * Sorts by the timestamp embedded in filename (YYYYMMDD_HHMMSS format)
 */
function findLatestReport(reportsDir, pattern) {
    if (!fs.existsSync(reportsDir)) {
        return null;
    }

    const files = fs.readdirSync(reportsDir)
        .filter(f => f.includes(pattern) && f.endsWith('.md'));

    if (files.length === 0) {
        return null;
    }

    // Sort by the timestamp portion of the filename (YYYYMMDD_HHMMSS)
    const tsRegex = /_(\d{8}_\d{6})/;
    files.sort((a, b) => {
        const matchA = a.match(tsRegex);
        const matchB = b.match(tsRegex);
        const tsA = matchA ? matchA[1] : '0';
        const tsB = matchB ? matchB[1] : '0';
        return tsB.localeCompare(tsA);
    });

    return path.join(reportsDir, files[0]);
}

/**
 * Validate that a report file matches the target date (stale report prevention)
 * @param {string} reportFile - Full path to report file
 * @param {string} targetDate - Target date in YYYY-MM-DD format
 * @throws {Error} if report doesn't match target date
 */
function validateReportDate(reportFile, targetDate) {
    const [year, month, day] = targetDate.split('-');
    const targetDateMMDDYYYY = `${month}${day}${year}`;

    if (!reportFile.includes(`End${targetDateMMDDYYYY}`) && !reportFile.includes(targetDate)) {
        throw new Error(
            `Found report does not match target date ${targetDate}. ` +
            `Report found: ${path.basename(reportFile)}. ` +
            `This likely means report generation failed silently.`
        );
    }
}

/**
 * Generate and send DOD report for a specific date
 */
async function runDODReport(config, clientName, targetDate) {
    const rootDir = path.join(__dirname, '..');

    console.log(`\n========================================`);
    console.log(`  DOD Report for ${config.client.name} - ${targetDate}`);
    console.log(`========================================`);

    // Step 1: Fetch data
    const fetchSuccess = runCommand(
        'Fetching Vapi data',
        `node scripts/fetch.js --client=${clientName} --days=2`,
        rootDir
    );
    if (!fetchSuccess) throw new Error('Fetch failed');

    // Step 2: Enrich data
    const startDate = format(subDays(new Date(targetDate), 7), 'yyyy-MM-dd');
    const enrichSuccess = runCommand(
        'Enriching call data',
        `node scripts/enrich.js --client=${clientName} --start=${startDate} --end=${targetDate} --force`,
        rootDir
    );
    if (!enrichSuccess) throw new Error('Enrichment failed');

    // Step 3: Generate DOD report
    const reportSuccess = runCommand(
        'Generating DOD report',
        `node scripts/report-day-over-day.js --client=${clientName} --date=${targetDate}`,
        rootDir
    );
    if (!reportSuccess) throw new Error('Report generation failed');

    // Step 4: Find the report
    const reportFile = findLatestReport(config.paths.reportsDir, 'EngAgent_DODReport');
    if (!reportFile) {
        throw new Error('Could not find generated DOD report');
    }

    // Validate report date (stale report prevention)
    validateReportDate(reportFile, targetDate);

    console.log(`\nReport generated: ${path.basename(reportFile)}`);

    // Load report content and metadata
    const reportContent = fs.readFileSync(reportFile, 'utf8');

    // Load metadata from companion JSON file
    const metaPath = reportFile.replace('.md', '_meta.json');
    let meta = {};
    if (fs.existsSync(metaPath)) {
        meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
        console.log(`Metadata loaded: ${meta.titleLine}`);
    }

    // Send email
    console.log('\nSending email...');
    await sendReport(config, 'dod', reportContent, reportFile, meta);

    console.log('\n[OK] DOD Report complete!');
    return reportFile;
}

/**
 * Generate and send Intraday report for a specific date
 */
async function runIntradayReport(config, clientName, targetDate) {
    const rootDir = path.join(__dirname, '..');

    console.log(`\n========================================`);
    console.log(`  Intraday Report for ${config.client.name} - ${targetDate}`);
    console.log(`========================================`);

    // Step 1: Fetch data
    const fetchSuccess = runCommand(
        'Fetching Vapi data',
        `node scripts/fetch.js --client=${clientName} --days=1`,
        rootDir
    );
    if (!fetchSuccess) throw new Error('Fetch failed');

    // Step 2: Enrich data
    const enrichSuccess = runCommand(
        'Enriching call data',
        `node scripts/enrich.js --client=${clientName} --date=${targetDate} --force`,
        rootDir
    );
    if (!enrichSuccess) throw new Error('Enrichment failed');

    // Step 3: Generate Intraday report
    const reportSuccess = runCommand(
        'Generating Intraday report',
        `node scripts/report-intraday.js --client=${clientName} --date=${targetDate}`,
        rootDir
    );
    if (!reportSuccess) throw new Error('Report generation failed');

    // Step 4: Find the report
    const reportFile = findLatestReport(config.paths.reportsDir, `intraday_report_${targetDate}`);
    if (!reportFile) {
        console.log(`\nNo report generated - likely no calls for ${targetDate} yet`);
        console.log(`This is normal for early morning runs.`);
        return null;
    }

    console.log(`\nReport generated: ${path.basename(reportFile)}`);

    const reportContent = fs.readFileSync(reportFile, 'utf8');

    // Load metadata from companion JSON file
    const metaPath = reportFile.replace('.md', '_meta.json');
    let meta = {};
    if (fs.existsSync(metaPath)) {
        meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    }

    // Send email
    console.log('\nSending email...');
    await sendReport(config, 'intraday', reportContent, reportFile, meta);

    console.log('\n[OK] Intraday Report complete!');
    return reportFile;
}

/**
 * Parse command line arguments
 */
function parseArgs() {
    const args = process.argv.slice(2);
    const result = {
        client: null,
        type: null,
        date: null,
        testEmail: false
    };

    for (const arg of args) {
        if (arg.startsWith('--client=')) {
            result.client = arg.split('=')[1];
        } else if (arg.startsWith('--type=')) {
            result.type = arg.split('=')[1];
        } else if (arg.startsWith('--date=')) {
            result.date = arg.split('=')[1];
        } else if (arg === '--test-email') {
            result.testEmail = true;
        }
    }

    return result;
}

/**
 * Main entry point
 */
async function main() {
    const startTime = Date.now();
    console.log(`\nScheduled Report Runner`);
    console.log(`Started at: ${new Date().toISOString()}`);

    try {
        const args = parseArgs();

        // Validate client argument
        if (!args.client) {
            console.error('Error: --client argument is required');
            console.log('\nUsage:');
            console.log('  node scripts/scheduled-report.js --client=<name> --type=dod [--date=YYYY-MM-DD]');
            console.log('  node scripts/scheduled-report.js --client=<name> --type=intraday [--date=YYYY-MM-DD]');
            console.log('  node scripts/scheduled-report.js --client=<name> --test-email');
            process.exit(1);
        }

        // Load client config
        const config = loadClientConfig(args.client);
        console.log(`Client: ${config.client.name}`);
        console.log(`AI Assistant: ${config.client.aiAssistantName}`);

        // Test email mode
        if (args.testEmail) {
            console.log('\nSending test email...');
            await sendTestEmail(config);
            console.log('[OK] Test email sent successfully!');
            return;
        }

        // Validate report type
        if (!args.type || !['dod', 'intraday'].includes(args.type)) {
            console.error('Error: --type=dod or --type=intraday is required');
            console.log('\nUsage:');
            console.log('  node scripts/scheduled-report.js --client=<name> --type=dod [--date=YYYY-MM-DD]');
            console.log('  node scripts/scheduled-report.js --client=<name> --type=intraday [--date=YYYY-MM-DD]');
            console.log('  node scripts/scheduled-report.js --client=<name> --test-email');
            process.exit(1);
        }

        // Determine target date
        let targetDate = args.date;
        if (!targetDate) {
            if (args.type === 'dod') {
                targetDate = format(subDays(new Date(), 1), 'yyyy-MM-dd');
            } else {
                targetDate = format(new Date(), 'yyyy-MM-dd');
            }
        }

        console.log(`Report type: ${args.type.toUpperCase()}`);
        console.log(`Target date: ${targetDate}`);

        // Run the appropriate report
        if (args.type === 'dod') {
            await runDODReport(config, args.client, targetDate);
        } else {
            await runIntradayReport(config, args.client, targetDate);
        }

        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        console.log(`\nTotal time: ${elapsed}s`);

    } catch (error) {
        console.error(`\nFatal error: ${error.message}`);
        console.error(error.stack);
        process.exit(1);
    }
}

main();

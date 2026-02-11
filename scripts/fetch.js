/**
 * Fetch Vapi Call Data - Generic script for any client
 *
 * Usage: node fetch.js --client=bathfitter [--days=7]
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const https = require('https');
const { subDays, format } = require('date-fns');
const { loadClientConfig } = require('../core/config-loader');

// Parse command line arguments
const args = process.argv.slice(2);
const clientArg = args.find(arg => arg.startsWith('--client='));
const daysArg = args.find(arg => arg.startsWith('--days='));

if (!clientArg) {
    console.error('Error: --client argument is required');
    console.error('Usage: node fetch.js --client=<clientname> [--days=7]');
    process.exit(1);
}

const clientName = clientArg.split('=')[1];
const daysToFetch = daysArg ? parseInt(daysArg.split('=')[1]) : 7;

// Load client configuration
const config = loadClientConfig(clientName);
const VAPI_API_KEY = process.env[config.client.vapi.apiKeyEnvVar] || process.env.VAPI_API_KEY;
const TARGET_PHONES = config.client.vapi.phoneNumbers;
const WARM_TRANSFER_PHONES = config.client.vapi.warmTransferPhoneNumbers || [];
const ALL_PHONES = [...TARGET_PHONES, ...WARM_TRANSFER_PHONES];
const BASE_URL = 'api.vapi.ai';

console.log(`=== Fetching Vapi calls for ${config.client.name} ===`);
console.log(`Phone numbers: ${TARGET_PHONES.join(', ')}`);
if (WARM_TRANSFER_PHONES.length > 0) {
    console.log(`Warm transfer phones: ${WARM_TRANSFER_PHONES.join(', ')}`);
}
console.log(`Days to fetch: ${daysToFetch}`);

if (!VAPI_API_KEY) {
    console.error(`Error: ${config.client.vapi.apiKeyEnvVar} environment variable is not set.`);
    process.exit(1);
}

// Helper: Load metadata
function loadMetadata() {
    if (!fs.existsSync(config.paths.metadataFile)) {
        return {
            lastFetchTimestamp: null,
            lastFetchedCallId: null,
            totalCallsStored: 0,
            lastEnrichmentTimestamp: null,
            totalCallsEnriched: 0
        };
    }
    return JSON.parse(fs.readFileSync(config.paths.metadataFile, 'utf-8'));
}

// Helper: Save metadata
function saveMetadata(metadata) {
    fs.writeFileSync(config.paths.metadataFile, JSON.stringify(metadata, null, 2));
}

// Helper: Save calls to daily files
function saveDailyRawData(calls) {
    const callsByDate = {};

    calls.forEach(call => {
        if (!call.createdAt) return;
        const dateKey = format(new Date(call.createdAt), 'yyyy-MM-dd');
        if (!callsByDate[dateKey]) {
            callsByDate[dateKey] = [];
        }
        callsByDate[dateKey].push(call);
    });

    Object.entries(callsByDate).forEach(([dateKey, dateCalls]) => {
        const filename = path.join(config.paths.rawDir, `vapi_calls_${dateKey}.json`);

        // Load existing data if file exists
        let existingCalls = [];
        if (fs.existsSync(filename)) {
            existingCalls = JSON.parse(fs.readFileSync(filename, 'utf-8'));
        }

        // Merge and deduplicate by call ID
        const callMap = new Map();
        existingCalls.forEach(c => callMap.set(c.id, c));
        dateCalls.forEach(c => callMap.set(c.id, c));

        const mergedCalls = Array.from(callMap.values());
        fs.writeFileSync(filename, JSON.stringify(mergedCalls, null, 2));
        console.log(`Saved ${mergedCalls.length} calls to ${filename} (${dateCalls.length} new)`);
    });
}

// Helper: Promisified HTTPS request
function httpsRequest(pathStr) {
    return new Promise((resolve, reject) => {
        const options = {
            hostname: BASE_URL,
            path: pathStr,
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${VAPI_API_KEY}`,
                'Content-Type': 'application/json'
            }
        };

        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', (chunk) => {
                data += chunk;
            });
            res.on('end', () => {
                if (res.statusCode >= 200 && res.statusCode < 300) {
                    try {
                        resolve(JSON.parse(data));
                    } catch (error) {
                        reject(new Error(`JSON parse error: ${error.message}`));
                    }
                } else {
                    reject(new Error(`HTTP ${res.statusCode}: ${data}`));
                }
            });
        });

        req.on('error', reject);
        req.setTimeout(30000, () => {
            req.destroy();
            reject(new Error('Request timeout'));
        });
        req.end();
    });
}

// Fetch calls with pagination
async function fetchCalls(startDate, endDate) {
    const allCalls = [];
    const callIds = new Set();
    let cursor = null;
    let page = 0;
    const PAGE_LIMIT = 100;
    // For array responses (no cursor), paginate by shifting the upper bound
    let currentEndDate = endDate;

    do {
        page++;
        console.log(`Fetching page ${page}...`);

        let queryPath = `/call?limit=${PAGE_LIMIT}&createdAtGe=${startDate.toISOString()}&createdAtLe=${currentEndDate.toISOString()}`;
        if (cursor) {
            queryPath += `&cursor=${cursor}`;
        }

        try {
            const response = await httpsRequest(queryPath);

            if (response && Array.isArray(response)) {
                // Deduplicate by call ID
                const newCalls = response.filter(c => !callIds.has(c.id));
                newCalls.forEach(c => callIds.add(c.id));
                allCalls.push(...newCalls);
                console.log(`Received ${response.length} calls (${newCalls.length} new)`);

                // If we got a full page, there are likely more — paginate by shifting the upper bound
                if (response.length >= PAGE_LIMIT) {
                    // Find the oldest call's createdAt and use it as the new upper bound
                    const oldest = response.reduce((min, c) =>
                        c.createdAt < min.createdAt ? c : min, response[0]);
                    const newEnd = new Date(oldest.createdAt);
                    // Avoid infinite loop if upper bound didn't change
                    if (newEnd.getTime() >= currentEndDate.getTime()) {
                        console.log('No progress in pagination, stopping');
                        break;
                    }
                    currentEndDate = newEnd;
                } else {
                    break; // Got less than a full page, we have all the data
                }
            } else if (response && response.data) {
                const newCalls = response.data.filter(c => !callIds.has(c.id));
                newCalls.forEach(c => callIds.add(c.id));
                allCalls.push(...newCalls);
                cursor = response.cursor || null;
                console.log(`Received ${response.data.length} calls (cursor: ${cursor ? 'yes' : 'no'})`);
                if (!cursor) break;
            } else {
                break;
            }
        } catch (error) {
            console.error(`Error fetching page ${page}:`, error.message);
            break;
        }

        // Safety limit
        if (page >= 50) {
            console.warn('Reached maximum page limit (50)');
            break;
        }

    } while (true);

    console.log(`Total calls fetched: ${allCalls.length}`);
    return allCalls;
}

// Filter calls by phone number (includes warm transfer lines)
function filterByPhone(calls) {
    return calls.filter(call => {
        const toHeader = call.phoneCallProviderDetails?.sip?.headers?.to;
        const sipUri = call.phoneCallProviderDetails?.sip?.uri;

        return ALL_PHONES.some(phone => {
            return (toHeader && toHeader.includes(phone)) ||
                   (sipUri && sipUri.includes(phone));
        });
    });
}

// Tag warm transfer calls
function tagWarmTransfers(calls) {
    if (WARM_TRANSFER_PHONES.length === 0) return calls;

    return calls.map(call => {
        const toHeader = call.phoneCallProviderDetails?.sip?.headers?.to;
        const sipUri = call.phoneCallProviderDetails?.sip?.uri;

        const isWarmTransfer = WARM_TRANSFER_PHONES.some(phone =>
            (toHeader && toHeader.includes(phone)) ||
            (sipUri && sipUri.includes(phone))
        );

        if (isWarmTransfer) {
            call._warmTransfer = true;
        }
        return call;
    });
}

// Main execution
async function main() {
    try {
        const metadata = loadMetadata();
        const endDate = new Date();
        const startDate = subDays(endDate, daysToFetch);

        console.log(`Fetching calls from ${format(startDate, 'yyyy-MM-dd')} to ${format(endDate, 'yyyy-MM-dd')}`);

        const allCalls = await fetchCalls(startDate, endDate);
        let filteredCalls = filterByPhone(allCalls);
        filteredCalls = tagWarmTransfers(filteredCalls);

        const warmCount = filteredCalls.filter(c => c._warmTransfer).length;
        console.log(`Filtered to ${filteredCalls.length} calls for ${config.client.name}${warmCount > 0 ? ` (${warmCount} warm transfers)` : ''}`);

        if (filteredCalls.length > 0) {
            saveDailyRawData(filteredCalls);

            metadata.lastFetchTimestamp = new Date().toISOString();
            metadata.totalCallsStored = (metadata.totalCallsStored || 0) + filteredCalls.length;
            saveMetadata(metadata);

            console.log(`✅ Fetch complete: ${filteredCalls.length} calls saved`);
        } else {
            console.log('No new calls to save');
        }

    } catch (error) {
        console.error('Fetch failed:', error.message);
        process.exit(1);
    }
}

main();

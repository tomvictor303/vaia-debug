require('dotenv').config();
const fs = require('node:fs/promises');
const path = require('node:path');
const readline = require('node:readline/promises');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { stdin: input, stdout: output } = require('node:process');

const API_URL = 'https://api.vapi.ai/call';
const CALL_PAGE_LIMIT = 300;
const API_REQUEST_DELAY_MS = 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_SCAN_DAYS = 20;
const SUCCESS_ENDED_REASON = 'assistant-forwarded-call';
const FAILED_ENDED_REASON = 'call.in-progress.error-transfer-failed';
const TARGET_ENDED_REASONS = [SUCCESS_ENDED_REASON, FAILED_ENDED_REASON];

const apiKey = process.env.VAPI_API_KEY?.trim();

function delay(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function requireAssistantId() {
  const assistantId = process.env.PCAPS_OF_ASSISTANT_ID?.trim();
  if (!assistantId) {
    throw new Error('PCAPS_OF_ASSISTANT_ID environment variable is required');
  }
  if (!/^[A-Za-z0-9_-]+$/.test(assistantId)) {
    throw new Error('PCAPS_OF_ASSISTANT_ID contains invalid characters');
  }

  return assistantId;
}

async function promptForCount() {
  const rl = readline.createInterface({ input, output });

  try {
    const countText = (await rl.question('How many PCAPs per ended reason? ')).trim();
    const count = Number(countText);
    if (!Number.isSafeInteger(count) || count <= 0) {
      throw new Error('PCAP count must be a positive integer');
    }

    return count;
  } finally {
    rl.close();
  }
}

async function fetchCallWindow(assistantId, windowStart, windowEnd) {
  const url = new URL(API_URL);
  url.searchParams.set('assistantId', assistantId);
  url.searchParams.set('limit', String(CALL_PAGE_LIMIT));
  url.searchParams.set('createdAtGe', new Date(windowStart).toISOString());
  url.searchParams.set('createdAtLe', new Date(windowEnd).toISOString());

  const response = await fetch(url, {
    method: 'GET',
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch calls. HTTP status: ${response.status}`);
  }

  const calls = await response.json();
  if (!Array.isArray(calls)) {
    throw new Error('Unexpected API response: expected an array of calls');
  }

  return calls;
}

function getCallTimestamp(call) {
  return call.startedAt || call.createdAt;
}

function compareCallsNewestFirst(firstCall, secondCall) {
  return new Date(secondCall.createdAt).getTime() -
    new Date(firstCall.createdAt).getTime();
}

async function findTargetCalls(assistantId, count) {
  const selectedCalls = new Map(
    TARGET_ENDED_REASONS.map(endedReason => [endedReason, []])
  );
  const seenCallIds = new Set();
  let requestCount = 0;
  let daysScanned = 0;
  let inspectedCallCount = 0;
  let matchingCallsWithoutPcap = 0;

  function quotasAreFilled() {
    return TARGET_ENDED_REASONS.every(
      endedReason => selectedCalls.get(endedReason).length >= count
    );
  }

  function inspectCompleteWindow(calls) {
    calls.sort(compareCallsNewestFirst);

    for (const call of calls) {
      if (quotasAreFilled()) {
        break;
      }
      if (!call.id || seenCallIds.has(call.id)) {
        continue;
      }
      seenCallIds.add(call.id);
      inspectedCallCount += 1;

      if (!TARGET_ENDED_REASONS.includes(call.endedReason)) {
        continue;
      }
      if (typeof call.pcapUrl !== 'string' || !call.pcapUrl.trim()) {
        matchingCallsWithoutPcap += 1;
        continue;
      }

      const callsForReason = selectedCalls.get(call.endedReason);
      if (callsForReason.length < count) {
        callsForReason.push(call);
      }
    }
  }

  async function scanAdaptiveWindow(windowStart, windowEnd) {
    if (quotasAreFilled()) {
      return;
    }

    if (requestCount > 0) {
      console.log(`Waiting ${API_REQUEST_DELAY_MS} ms before the next API request...`);
      await delay(API_REQUEST_DELAY_MS);
    }

    requestCount += 1;
    const calls = await fetchCallWindow(assistantId, windowStart, windowEnd);
    console.log(
      `Request ${requestCount}: ${calls.length} calls from ` +
      `${new Date(windowStart).toISOString()} through ${new Date(windowEnd).toISOString()}`
    );

    if (calls.length < CALL_PAGE_LIMIT) {
      inspectCompleteWindow(calls);
      return;
    }

    if (windowStart >= windowEnd) {
      throw new Error(
        `A one-millisecond window at ${new Date(windowStart).toISOString()} ` +
        `reached the ${CALL_PAGE_LIMIT}-call limit; recency cannot be guaranteed`
      );
    }

    const midpoint = Math.floor((windowStart + windowEnd) / 2);
    console.log('Window reached the 300-call limit; splitting it into newer and older halves.');

    // Scan the newer half first. Only inspect the older half if quotas remain open.
    await scanAdaptiveWindow(midpoint + 1, windowEnd);
    await scanAdaptiveWindow(windowStart, midpoint);
  }

  const scanEnd = Date.now();
  for (let dayIndex = 0; dayIndex < MAX_SCAN_DAYS; dayIndex += 1) {
    if (quotasAreFilled()) {
      break;
    }

    const dayEnd = scanEnd - dayIndex * DAY_MS;
    const dayStart = dayEnd - DAY_MS + 1;
    daysScanned += 1;
    console.log(`\nScanning day ${daysScanned} of ${MAX_SCAN_DAYS}...`);
    await scanAdaptiveWindow(dayStart, dayEnd);
  }

  if (!quotasAreFilled()) {
    console.log(`Reached the ${MAX_SCAN_DAYS}-day scan limit before both quotas were filled.`);
  }

  return {
    selectedCalls,
    inspectedCallCount,
    matchingCallsWithoutPcap,
    requestCount,
    daysScanned,
  };
}

function pad(value, length = 2) {
  return String(value).padStart(length, '0');
}

function formatLocalTimestamp(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid call start time: ${value || '(missing)'}`);
  }

  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
  ].join('') +
    `_${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}` +
    `_${pad(date.getMilliseconds(), 3)}`;
}

function createPcapPath(assistantId, call) {
  const fileName = `${formatLocalTimestamp(getCallTimestamp(call))}_${call.id}.pcap`;
  return path.join(__dirname, 'pcap', assistantId, call.endedReason, fileName);
}

async function downloadPcap(call, assistantId) {
  const destinationPath = createPcapPath(assistantId, call);
  const temporaryPath = `${destinationPath}.part`;
  await fs.mkdir(path.dirname(destinationPath), { recursive: true });

  try {
    await fs.access(destinationPath);
    console.log(`Already exists, skipped: ${destinationPath}`);
    return { status: 'skipped', destinationPath };
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw error;
    }
  }

  const response = await fetch(call.pcapUrl);
  if (!response.ok || !response.body) {
    throw new Error(`PCAP download failed. HTTP status: ${response.status}`);
  }

  try {
    await pipeline(
      Readable.fromWeb(response.body),
      require('node:fs').createWriteStream(temporaryPath, { flags: 'wx' })
    );
    await fs.rename(temporaryPath, destinationPath);
  } catch (error) {
    await fs.rm(temporaryPath, { force: true });
    throw error;
  }

  console.log(`Downloaded: ${destinationPath}`);
  return { status: 'downloaded', destinationPath };
}

async function main() {
  if (!apiKey) {
    throw new Error('VAPI_API_KEY environment variable is required');
  }

  const assistantId = requireAssistantId();
  const count = await promptForCount();
  const result = await findTargetCalls(assistantId, count);

  console.log(
    `\nInspected ${result.inspectedCallCount} calls across ` +
    `${result.daysScanned} days and ${result.requestCount} API requests.`
  );
  if (result.matchingCallsWithoutPcap > 0) {
    console.log(`Matching calls without a PCAP URL: ${result.matchingCallsWithoutPcap}`);
  }

  let downloadedCount = 0;
  let skippedCount = 0;
  let failedCount = 0;

  for (const endedReason of TARGET_ENDED_REASONS) {
    const calls = result.selectedCalls.get(endedReason);
    console.log(`\n${endedReason}: found ${calls.length} of ${count} requested PCAPs`);

    for (const call of calls) {
      try {
        const downloadResult = await downloadPcap(call, assistantId);
        if (downloadResult.status === 'downloaded') {
          downloadedCount += 1;
        } else {
          skippedCount += 1;
        }
      } catch (error) {
        failedCount += 1;
        console.error(`Failed ${call.id}: ${error.message}`);
      }
    }
  }

  console.log('\nDownload summary:');
  console.log(`- Downloaded: ${downloadedCount}`);
  console.log(`- Already existed: ${skippedCount}`);
  console.log(`- Failed: ${failedCount}`);
}

main().catch(error => {
  console.error('Error:', error.message);
  process.exitCode = 1;
});

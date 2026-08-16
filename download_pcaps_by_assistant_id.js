require('dotenv').config();
const fs = require('node:fs/promises');
const path = require('node:path');
const readline = require('node:readline/promises');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { stdin: input, stdout: output } = require('node:process');

const API_URL = 'https://api.vapi.ai/call';
const CALL_PAGE_LIMIT = 300;
const MAX_PAGE_COUNT = 10;
const PAGINATION_DELAY_MS = 1000;
const SUCCESS_ENDED_REASON = 'assistant-forwarded-call';
const FAILED_ENDED_REASON = 'call.in-progress.error-transfer-failed';
const TARGET_ENDED_REASONS = [SUCCESS_ENDED_REASON, FAILED_ENDED_REASON];

const apiKey = process.env.VAPI_API_KEY?.trim();

function delay(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function promptForOptions() {
  const rl = readline.createInterface({ input, output });

  try {
    const assistantId = (await rl.question('Assistant ID: ')).trim();
    if (!assistantId) {
      throw new Error('Assistant ID is required');
    }
    if (!/^[A-Za-z0-9_-]+$/.test(assistantId)) {
      throw new Error('Assistant ID contains invalid characters');
    }

    const countText = (await rl.question('How many PCAPs per ended reason? ')).trim();
    const count = Number(countText);
    if (!Number.isSafeInteger(count) || count <= 0) {
      throw new Error('PCAP count must be a positive integer');
    }

    return { assistantId, count };
  } finally {
    rl.close();
  }
}

async function fetchCallsPage(assistantId, createdAtLt) {
  const url = new URL(API_URL);
  url.searchParams.set('assistantId', assistantId);
  url.searchParams.set('limit', String(CALL_PAGE_LIMIT));
  if (createdAtLt) {
    url.searchParams.set('createdAtLt', createdAtLt);
  }

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
  return new Date(getCallTimestamp(secondCall)).getTime() -
    new Date(getCallTimestamp(firstCall)).getTime();
}

async function findTargetCalls(assistantId, count) {
  const selectedCalls = new Map(
    TARGET_ENDED_REASONS.map(endedReason => [endedReason, []])
  );
  const seenCallIds = new Set();
  let createdAtLt;
  let pageNumber = 0;
  let inspectedCallCount = 0;
  let matchingCallsWithoutPcap = 0;

  while (
    pageNumber < MAX_PAGE_COUNT &&
    TARGET_ENDED_REASONS.some(
      endedReason => selectedCalls.get(endedReason).length < count
    )
  ) {
    pageNumber += 1;
    const calls = await fetchCallsPage(assistantId, createdAtLt);
    inspectedCallCount += calls.length;
    console.log(`Fetched page ${pageNumber}: ${calls.length} calls`);

    if (calls.length === 0) {
      break;
    }

    calls.sort(compareCallsNewestFirst);
    for (const call of calls) {
      if (!call.id || seenCallIds.has(call.id)) {
        continue;
      }
      seenCallIds.add(call.id);

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

    if (calls.length < CALL_PAGE_LIMIT) {
      break;
    }
    if (pageNumber >= MAX_PAGE_COUNT) {
      break;
    }

    const validCreatedTimes = calls
      .map(call => call.createdAt)
      .filter(value => typeof value === 'string' && !Number.isNaN(Date.parse(value)))
      .sort();
    const nextCreatedAtLt = validCreatedTimes[0];
    if (!nextCreatedAtLt || nextCreatedAtLt === createdAtLt) {
      console.warn('Cannot determine a new pagination boundary; stopping.');
      break;
    }

    createdAtLt = nextCreatedAtLt;
    console.log(`Waiting ${PAGINATION_DELAY_MS} ms before the next page...`);
    await delay(PAGINATION_DELAY_MS);
  }

  if (
    pageNumber >= MAX_PAGE_COUNT &&
    TARGET_ENDED_REASONS.some(
      endedReason => selectedCalls.get(endedReason).length < count
    )
  ) {
    console.log(`Reached the maximum of ${MAX_PAGE_COUNT} pages; stopping the search.`);
  }

  return {
    selectedCalls,
    inspectedCallCount,
    matchingCallsWithoutPcap,
    pageCount: pageNumber,
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

  const { assistantId, count } = await promptForOptions();
  const result = await findTargetCalls(assistantId, count);

  console.log(`\nInspected ${result.inspectedCallCount} calls across ${result.pageCount} pages.`);
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

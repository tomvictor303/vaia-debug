require('dotenv').config();
const fs = require('node:fs/promises');
const path = require('node:path');

const ENDED_REASONS = [
  'assistant-forwarded-call',
  'call.in-progress.error-transfer-failed',
];
const REFER_TO_PATTERN = /Refer-To\s*:\s*<\s*sips?:([^;>\s?]+)/gi;

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

async function findPcapFiles(directoryPath) {
  let entries;
  try {
    entries = await fs.readdir(directoryPath, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') {
      return [];
    }
    throw error;
  }

  const files = [];
  for (const entry of entries) {
    const entryPath = path.join(directoryPath, entry.name);
    if (entry.isDirectory()) {
      files.push(...await findPcapFiles(entryPath));
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.pcap')) {
      files.push(entryPath);
    }
  }

  return files;
}

function extractReferToTargets(buffer) {
  const content = buffer.toString('latin1');
  const targets = [];
  let match;

  REFER_TO_PATTERN.lastIndex = 0;
  while ((match = REFER_TO_PATTERN.exec(content)) !== null) {
    targets.push(match[1]);
  }

  return targets;
}

function extractSipUri(headerValue) {
  const match = headerValue.match(/sips?:([^;>\s]+)/i);
  return match ? match[1] : headerValue.trim();
}

function extractFirstReferFromToPair(buffer) {
  const content = buffer.toString('latin1');
  const referPacketMatch = content.match(
    /REFER[ \t]+[^\r\n]+[ \t]+SIP\/2\.0\r?\n([\s\S]*?)\r?\n\r?\n/i
  );
  if (!referPacketMatch) {
    return null;
  }

  const headers = referPacketMatch[1];
  const fromMatch = headers.match(/^From\s*:\s*(.+)$/im);
  const toMatch = headers.match(/^To\s*:\s*(.+)$/im);
  if (!fromMatch || !toMatch) {
    return null;
  }

  return {
    from: extractSipUri(fromMatch[1]),
    to: extractSipUri(toMatch[1]),
  };
}

async function debugEndedReason(assistantId, endedReason) {
  const directoryPath = path.join(__dirname, 'pcap', assistantId, endedReason);
  const pcapFiles = await findPcapFiles(directoryPath);
  const uniqueTargets = new Set();
  const fromToPairs = new Map();
  let filesWithReferTo = 0;
  let filesWithFirstReferPair = 0;

  for (const pcapFile of pcapFiles) {
    const buffer = await fs.readFile(pcapFile);
    const targets = extractReferToTargets(buffer);
    if (targets.length > 0) {
      filesWithReferTo += 1;
    }
    targets.forEach(target => uniqueTargets.add(target));

    const pair = extractFirstReferFromToPair(buffer);
    if (pair) {
      filesWithFirstReferPair += 1;
      const pairKey = `${pair.from}\t${pair.to}`;
      const existingPair = fromToPairs.get(pairKey);
      if (existingPair) {
        existingPair.fileCount += 1;
      } else {
        fromToPairs.set(pairKey, { ...pair, fileCount: 1 });
      }
    }
  }

  const sortedTargets = [...uniqueTargets].sort((firstTarget, secondTarget) =>
    firstTarget.localeCompare(secondTarget, undefined, { numeric: true })
  );

  console.log(`Directory "${endedReason}"`);
  console.log(`PCAP files scanned: ${pcapFiles.length}`);
  console.log(`PCAP files containing Refer-To: ${filesWithReferTo}`);
  console.log(`Unique Refer-To categories: ${sortedTargets.length}`);
  sortedTargets.forEach(target => {
    console.log(`- ${target}`);
  });

  const sortedPairs = [...fromToPairs.values()].sort((firstPair, secondPair) =>
    firstPair.from.localeCompare(secondPair.from, undefined, { numeric: true }) ||
    firstPair.to.localeCompare(secondPair.to, undefined, { numeric: true })
  );

  console.log(`\nPCAP files with a complete first REFER From-To pair: ${filesWithFirstReferPair}`);
  console.log(`Unique first REFER From-To pairs for ${endedReason}: ${sortedPairs.length}`);
  sortedPairs.forEach(pair => {
    console.log(`- From: ${pair.from} -> To: ${pair.to} (${pair.fileCount} files)`);
  });

  return { sortedTargets, sortedPairs };
}

async function main() {
  const assistantId = requireAssistantId();
  console.log(`Assistant ID: ${assistantId}`);

  for (const [index, endedReason] of ENDED_REASONS.entries()) {
    if (index === 0) {
      process.stdout.write('\n');
    } else {
      process.stdout.write(`\n\n${'='.repeat(60)}\n\n\n`);
    }
    await debugEndedReason(assistantId, endedReason);
  }
}

main().catch(error => {
  console.error('Error:', error.message);
  process.exitCode = 1;
});

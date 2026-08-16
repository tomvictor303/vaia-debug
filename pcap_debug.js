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

async function debugEndedReason(assistantId, endedReason) {
  const directoryPath = path.join(__dirname, 'pcap', assistantId, endedReason);
  const pcapFiles = await findPcapFiles(directoryPath);
  const uniqueTargets = new Set();
  let filesWithReferTo = 0;

  for (const pcapFile of pcapFiles) {
    const buffer = await fs.readFile(pcapFile);
    const targets = extractReferToTargets(buffer);
    if (targets.length > 0) {
      filesWithReferTo += 1;
    }
    targets.forEach(target => uniqueTargets.add(target));
  }

  const sortedTargets = [...uniqueTargets].sort((firstTarget, secondTarget) =>
    firstTarget.localeCompare(secondTarget, undefined, { numeric: true })
  );

  console.log(`\n${endedReason}`);
  console.log(`PCAP files scanned: ${pcapFiles.length}`);
  console.log(`PCAP files containing Refer-To: ${filesWithReferTo}`);
  console.log(`Unique Refer-To categories: ${sortedTargets.length}`);
  sortedTargets.forEach(target => {
    console.log(`- ${target}`);
  });

  return sortedTargets;
}

async function main() {
  const assistantId = requireAssistantId();
  console.log(`Assistant ID: ${assistantId}`);

  for (const endedReason of ENDED_REASONS) {
    await debugEndedReason(assistantId, endedReason);
  }
}

main().catch(error => {
  console.error('Error:', error.message);
  process.exitCode = 1;
});

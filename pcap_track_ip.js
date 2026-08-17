require('dotenv').config();
const fs = require('node:fs/promises');
const net = require('node:net');
const path = require('node:path');
const readline = require('node:readline/promises');
const { stdin: input, stdout: output } = require('node:process');
const {
  extractPacketIpv4Addresses,
  extractTextIpv4Addresses,
  findPcapFiles,
} = require('./pcap_debug');

const ENDED_REASONS = [
  'assistant-forwarded-call',
  'call.in-progress.error-transfer-failed',
];

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

async function promptForIpAddress() {
  const rl = readline.createInterface({ input, output });

  try {
    const ipAddress = (await rl.question('IP address to track: ')).trim();
    if (net.isIP(ipAddress) === 0) {
      throw new Error('A valid IPv4 or IPv6 address is required');
    }
    return ipAddress;
  } finally {
    rl.close();
  }
}

function addressMatches(targetList, candidateAddress, targetVersion) {
  const candidateVersion = net.isIP(candidateAddress);
  if (candidateVersion !== targetVersion) {
    return false;
  }

  return targetList.check(
    candidateAddress,
    candidateVersion === 4 ? 'ipv4' : 'ipv6'
  );
}

async function findMatchingPcaps(directoryPath, ipAddress) {
  const pcapFiles = (await findPcapFiles(directoryPath)).sort((firstFile, secondFile) =>
    firstFile.localeCompare(secondFile, undefined, { numeric: true })
  );
  const matchingFiles = [];
  const targetVersion = net.isIP(ipAddress);
  const targetList = new net.BlockList();
  targetList.addAddress(ipAddress, targetVersion === 4 ? 'ipv4' : 'ipv6');

  for (const pcapFile of pcapFiles) {
    const buffer = await fs.readFile(pcapFile);
    const addresses = new Set([
      ...extractTextIpv4Addresses(buffer),
      ...extractPacketIpv4Addresses(buffer),
    ]);
    if ([...addresses].some(address =>
      addressMatches(targetList, address, targetVersion)
    )) {
      matchingFiles.push(pcapFile);
    }
  }

  return { matchingFiles, pcapFileCount: pcapFiles.length };
}

async function main() {
  const assistantId = requireAssistantId();
  const ipAddress = await promptForIpAddress();

  console.log(`\nAssistant ID: ${assistantId}`);
  console.log(`Tracking IP address: ${ipAddress}`);

  for (const [index, endedReason] of ENDED_REASONS.entries()) {
    if (index > 0) {
      process.stdout.write(`\n\n${'='.repeat(60)}\n\n\n`);
    }

    const directoryPath = path.join(__dirname, 'pcap', assistantId, endedReason);
    const result = await findMatchingPcaps(directoryPath, ipAddress);

    console.log(`Directory "${endedReason}"`);
    console.log(`PCAP files scanned: ${result.pcapFileCount}`);
    console.log(`PCAP files containing ${ipAddress}: ${result.matchingFiles.length}`);
    result.matchingFiles.forEach(pcapFile => {
      console.log(`- ${path.relative(__dirname, pcapFile)}`);
    });
  }
}

main().catch(error => {
  console.error('Error:', error.message);
  process.exitCode = 1;
});

require('dotenv').config();
const fs = require('node:fs/promises');
const net = require('node:net');
const path = require('node:path');

const ENDED_REASONS = [
  'assistant-forwarded-call',
  'call.in-progress.error-transfer-failed',
];
const REFER_TO_PATTERN = /Refer-To\s*:\s*<\s*sips?:([^;>\s?]+)/gi;
const IPV4_TEXT_PATTERN = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;
const IPV6_TEXT_PATTERN = /[0-9A-Fa-f]*:[0-9A-Fa-f:.]+/g;

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

function formatIpv4(buffer, offset) {
  if (offset < 0 || offset + 4 > buffer.length) {
    return null;
  }
  return [...buffer.subarray(offset, offset + 4)].join('.');
}

function formatIpv6(buffer, offset) {
  if (offset < 0 || offset + 16 > buffer.length) {
    return null;
  }

  const groups = [];
  for (let index = 0; index < 8; index += 1) {
    groups.push(buffer.readUInt16BE(offset + index * 2));
  }

  let bestStart = -1;
  let bestLength = 0;
  for (let index = 0; index < groups.length;) {
    if (groups[index] !== 0) {
      index += 1;
      continue;
    }
    let end = index;
    while (end < groups.length && groups[end] === 0) {
      end += 1;
    }
    if (end - index > bestLength) {
      bestStart = index;
      bestLength = end - index;
    }
    index = end;
  }

  if (bestLength < 2) {
    return groups.map(group => group.toString(16)).join(':');
  }

  const left = groups.slice(0, bestStart).map(group => group.toString(16)).join(':');
  const right = groups
    .slice(bestStart + bestLength)
    .map(group => group.toString(16))
    .join(':');
  return `${left}::${right}`;
}

function extractTextIpv4Addresses(buffer) {
  const addresses = new Set();
  const content = buffer.toString('latin1');
  const matches = content.match(IPV4_TEXT_PATTERN) || [];

  for (const address of matches) {
    if (address.split('.').every(part => Number(part) <= 255)) {
      addresses.add(address);
    }
  }

  const ipv6Matches = content.match(IPV6_TEXT_PATTERN) || [];
  for (const address of ipv6Matches) {
    if (net.isIP(address) === 6) {
      addresses.add(address.toLowerCase());
    }
  }

  return addresses;
}

function extractPacketIpv4Addresses(buffer) {
  const addresses = new Set();
  if (buffer.length < 24) {
    return addresses;
  }

  const magic = buffer.readUInt32BE(0);
  const littleEndian = magic === 0xd4c3b2a1 || magic === 0x4d3cb2a1;
  const bigEndian = magic === 0xa1b2c3d4 || magic === 0xa1b23c4d;
  if (!littleEndian && !bigEndian) {
    return addresses;
  }

  const readUInt32 = offset => littleEndian
    ? buffer.readUInt32LE(offset)
    : buffer.readUInt32BE(offset);
  const linkType = readUInt32(20);
  let recordOffset = 24;

  while (recordOffset + 16 <= buffer.length) {
    const capturedLength = readUInt32(recordOffset + 8);
    const packetStart = recordOffset + 16;
    const packetEnd = packetStart + capturedLength;
    if (packetEnd > buffer.length) {
      break;
    }

    let networkOffset;
    let etherType;

    if (linkType === 1 && capturedLength >= 14) {
      networkOffset = packetStart + 14;
      etherType = buffer.readUInt16BE(packetStart + 12);
      while (
        (etherType === 0x8100 || etherType === 0x88a8 || etherType === 0x9100) &&
        networkOffset + 4 <= packetEnd
      ) {
        etherType = buffer.readUInt16BE(networkOffset + 2);
        networkOffset += 4;
      }
    } else if (linkType === 113 && capturedLength >= 16) {
      networkOffset = packetStart + 16;
      etherType = buffer.readUInt16BE(packetStart + 14);
    } else if (linkType === 276 && capturedLength >= 20) {
      networkOffset = packetStart + 20;
      etherType = buffer.readUInt16BE(packetStart);
    } else if (linkType === 101) {
      networkOffset = packetStart;
      etherType = buffer[packetStart] >> 4 === 4 ? 0x0800 : undefined;
    }

    if (
      etherType === 0x0800 &&
      networkOffset !== undefined &&
      networkOffset + 20 <= packetEnd &&
      buffer[networkOffset] >> 4 === 4
    ) {
      const source = formatIpv4(buffer, networkOffset + 12);
      const destination = formatIpv4(buffer, networkOffset + 16);
      if (source) addresses.add(source);
      if (destination) addresses.add(destination);
    } else if (
      etherType === 0x86dd &&
      networkOffset !== undefined &&
      networkOffset + 40 <= packetEnd &&
      buffer[networkOffset] >> 4 === 6
    ) {
      const source = formatIpv6(buffer, networkOffset + 8);
      const destination = formatIpv6(buffer, networkOffset + 24);
      if (source) addresses.add(source);
      if (destination) addresses.add(destination);
    }

    recordOffset = packetEnd;
  }

  return addresses;
}

function compareIpAddresses(firstAddress, secondAddress) {
  const firstVersion = net.isIP(firstAddress);
  const secondVersion = net.isIP(secondAddress);
  if (firstVersion !== secondVersion) {
    return firstVersion - secondVersion;
  }
  if (firstVersion === 6) {
    return firstAddress.localeCompare(secondAddress, undefined, { numeric: true });
  }

  const firstParts = firstAddress.split('.').map(Number);
  const secondParts = secondAddress.split('.').map(Number);

  for (let index = 0; index < 4; index += 1) {
    if (firstParts[index] !== secondParts[index]) {
      return firstParts[index] - secondParts[index];
    }
  }
  return 0;
}

async function debugEndedReason(assistantId, endedReason) {
  const directoryPath = path.join(__dirname, 'pcap', assistantId, endedReason);
  const pcapFiles = await findPcapFiles(directoryPath);
  const uniqueTargets = new Set();
  const uniqueIpAddresses = new Set();
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
    extractTextIpv4Addresses(buffer).forEach(address => uniqueIpAddresses.add(address));
    extractPacketIpv4Addresses(buffer).forEach(address => uniqueIpAddresses.add(address));

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

  const sortedIpAddresses = [...uniqueIpAddresses].sort(compareIpAddresses);
  console.log(`\nUnique IP addresses for ${endedReason}: ${sortedIpAddresses.length}`);
  sortedIpAddresses.forEach(address => {
    console.log(`- ${address}`);
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

  return { sortedTargets, sortedIpAddresses, sortedPairs };
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

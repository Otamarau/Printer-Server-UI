const { execFile } = require("node:child_process");
const dgram = require("node:dgram");
const net = require("node:net");
const os = require("node:os");
const { promisify } = require("node:util");

const {
  PING_CONCURRENCY,
  PING_TIMEOUT_MS,
  SNMP_COMMUNITY,
  SNMP_MAX_SUPPLIES,
  SNMP_TIMEOUT_MS,
  VNC_PORT,
  VNC_SCAN_TIMEOUT_MS,
} = require("./config");
const { getLocations, readPrinters, writePrinters } = require("./store");
const { isValidIpAddress } = require("./utils");

const execFileAsync = promisify(execFile);
const isWindows = os.platform() === "win32";
const printerOids = {
  sysDescr: "1.3.6.1.2.1.1.1.0",
  sysName: "1.3.6.1.2.1.1.5.0",
  printerName: "1.3.6.1.2.1.43.5.1.1.16.1",
  serialNumber: "1.3.6.1.2.1.43.5.1.1.17.1",
  suppliesDescription: "1.3.6.1.2.1.43.11.1.1.6.1",
  suppliesMaxCapacity: "1.3.6.1.2.1.43.11.1.1.8.1",
  suppliesLevel: "1.3.6.1.2.1.43.11.1.1.9.1",
};
let statusCheckInProgress = false;
async function pingPrinter(ip) {
  if (!isValidIpAddress(ip)) {
    return false;
  }

  const args = isWindows
    ? ["-n", "1", "-w", String(PING_TIMEOUT_MS), ip]
    : ["-c", "1", "-W", String(Math.ceil(PING_TIMEOUT_MS / 1000)), ip];

  try {
    await execFileAsync("ping", args, { timeout: PING_TIMEOUT_MS + 500 });
    return true;
  } catch {
    return false;
  }
}

async function isTcpPortOpen(ip, port, timeoutMs) {
  if (!isValidIpAddress(ip)) {
    return false;
  }

  return new Promise((resolve) => {
    const socket = net.createConnection({ host: ip, port });
    let settled = false;

    const settle = (result) => {
      if (settled) {
        return;
      }

      settled = true;
      socket.destroy();
      resolve(result);
    };

    socket.setTimeout(timeoutMs);
    socket.once("connect", () => settle(true));
    socket.once("timeout", () => settle(false));
    socket.once("error", () => settle(false));
  });
}

function checkVncAvailable(ip) {
  return isTcpPortOpen(ip, VNC_PORT, VNC_SCAN_TIMEOUT_MS);
}

function encodeLength(length) {
  if (length < 0x80) {
    return Buffer.from([length]);
  }

  const bytes = [];
  let value = length;

  while (value > 0) {
    bytes.unshift(value & 0xff);
    value >>= 8;
  }

  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function encodeTlv(tag, value) {
  return Buffer.concat([Buffer.from([tag]), encodeLength(value.length), value]);
}

function encodeInteger(value) {
  if (value === 0) {
    return encodeTlv(0x02, Buffer.from([0]));
  }

  const bytes = [];
  let nextValue = value;

  while (nextValue > 0) {
    bytes.unshift(nextValue & 0xff);
    nextValue >>= 8;
  }

  if (bytes[0] & 0x80) {
    bytes.unshift(0);
  }

  return encodeTlv(0x02, Buffer.from(bytes));
}

function encodeString(value) {
  return encodeTlv(0x04, Buffer.from(String(value), "utf8"));
}

function encodeNull() {
  return Buffer.from([0x05, 0x00]);
}

function encodeOid(oid) {
  const parts = String(oid).split(".").map((part) => Number(part));
  const bytes = [parts[0] * 40 + parts[1]];

  for (const part of parts.slice(2)) {
    const oidBytes = [part & 0x7f];
    let value = part >> 7;

    while (value > 0) {
      oidBytes.unshift((value & 0x7f) | 0x80);
      value >>= 7;
    }

    bytes.push(...oidBytes);
  }

  return encodeTlv(0x06, Buffer.from(bytes));
}

function encodeSequence(items, tag = 0x30) {
  return encodeTlv(tag, Buffer.concat(items));
}

function buildSnmpRequest(oid, pduTag) {
  const requestId = Math.floor(Math.random() * 0x7fffffff);
  const varbind = encodeSequence([encodeOid(oid), encodeNull()]);
  const pdu = encodeSequence(
    [
      encodeInteger(requestId),
      encodeInteger(0),
      encodeInteger(0),
      encodeSequence([varbind]),
    ],
    pduTag,
  );

  return encodeSequence([
    encodeInteger(0),
    encodeString(SNMP_COMMUNITY),
    pdu,
  ]);
}

function readLength(buffer, offset) {
  const firstByte = buffer[offset];

  if ((firstByte & 0x80) === 0) {
    return { length: firstByte, offset: offset + 1 };
  }

  const byteCount = firstByte & 0x7f;
  let length = 0;

  for (let index = 0; index < byteCount; index += 1) {
    length = (length << 8) | buffer[offset + 1 + index];
  }

  return { length, offset: offset + 1 + byteCount };
}

function readTlv(buffer, offset = 0) {
  const tag = buffer[offset];
  const lengthData = readLength(buffer, offset + 1);
  const valueStart = lengthData.offset;
  const valueEnd = valueStart + lengthData.length;

  return {
    tag,
    value: buffer.subarray(valueStart, valueEnd),
    valueEnd,
  };
}

function readChildren(tlv) {
  const children = [];
  let offset = 0;

  while (offset < tlv.value.length) {
    const child = readTlv(tlv.value, offset);
    children.push(child);
    offset = child.valueEnd;
  }

  return children;
}

function decodeInteger(value) {
  if (!value.length) {
    return 0;
  }

  let result = 0;

  for (const byte of value) {
    result = (result << 8) | byte;
  }

  if (value[0] & 0x80) {
    result -= 2 ** (8 * value.length);
  }

  return result;
}

function decodeUnsignedInteger(value) {
  let result = 0;

  for (const byte of value) {
    result = (result << 8) | byte;
  }

  return result;
}

function decodeOid(value) {
  if (!value.length) {
    return "";
  }

  const firstByte = value[0];
  const parts = [Math.floor(firstByte / 40), firstByte % 40];
  let current = 0;

  for (const byte of value.slice(1)) {
    current = (current << 7) | (byte & 0x7f);

    if ((byte & 0x80) === 0) {
      parts.push(current);
      current = 0;
    }
  }

  return parts.join(".");
}

function decodeSnmpValue(tlv) {
  if (tlv.tag === 0x02) {
    return decodeInteger(tlv.value);
  }

  if ([0x41, 0x42, 0x43, 0x46].includes(tlv.tag)) {
    return decodeUnsignedInteger(tlv.value);
  }

  if (tlv.tag === 0x04) {
    return tlv.value.toString("utf8").replace(/\0/g, "").trim();
  }

  if (tlv.tag === 0x05) {
    return null;
  }

  if (tlv.tag === 0x06) {
    return decodeOid(tlv.value);
  }

  return tlv.value.toString("hex");
}

function parseSnmpResponse(buffer) {
  const message = readTlv(buffer);
  const messageItems = readChildren(message);
  const pdu = messageItems[2];

  if (!pdu) {
    return null;
  }

  const pduItems = readChildren(pdu);
  const errorStatus = pduItems[1] ? decodeInteger(pduItems[1].value) : 0;

  if (errorStatus !== 0 || !pduItems[3]) {
    return null;
  }

  const varbinds = readChildren(pduItems[3]);
  const firstVarbind = varbinds[0];

  if (!firstVarbind) {
    return null;
  }

  const varbindItems = readChildren(firstVarbind);

  if (varbindItems.length < 2) {
    return null;
  }

  return {
    oid: decodeOid(varbindItems[0].value),
    value: decodeSnmpValue(varbindItems[1]),
  };
}

async function snmpRequest(ip, oid, pduTag = 0xa0) {
  if (!isValidIpAddress(ip)) {
    return null;
  }

  const message = buildSnmpRequest(oid, pduTag);

  return new Promise((resolve) => {
    const socket = dgram.createSocket("udp4");
    const timeout = setTimeout(() => {
      socket.close();
      resolve(null);
    }, SNMP_TIMEOUT_MS);

    socket.once("message", (response) => {
      clearTimeout(timeout);
      socket.close();

      try {
        resolve(parseSnmpResponse(response));
      } catch {
        resolve(null);
      }
    });

    socket.once("error", () => {
      clearTimeout(timeout);
      socket.close();
      resolve(null);
    });

    socket.send(message, 161, ip, (error) => {
      if (error) {
        clearTimeout(timeout);
        socket.close();
        resolve(null);
      }
    });
  });
}

async function snmpWalk(ip, baseOid, maxRows = SNMP_MAX_SUPPLIES) {
  const values = new Map();
  let currentOid = baseOid;

  for (let count = 0; count < maxRows; count += 1) {
    const response = await snmpRequest(ip, currentOid, 0xa1);

    if (!response || !response.oid.startsWith(`${baseOid}.`)) {
      break;
    }

    const index = response.oid.slice(baseOid.length + 1);
    values.set(index, response.value);
    currentOid = response.oid;
  }

  return values;
}

function isTonerSupplyName(name) {
  const value = String(name || "").toLowerCase();

  if (!value) {
    return false;
  }

  if (/(waste|fuser|transfer|drum|maintenance|staple|paper|belt|cleaner)/.test(value)) {
    return false;
  }

  return /(toner|cartridge|black|cyan|magenta|yellow)/.test(value);
}

function supplyLevelStatus(percent) {
  if (!Number.isFinite(percent)) {
    return "Unknown";
  }

  if (percent <= 10) {
    return "Low";
  }

  if (percent <= 25) {
    return "Check";
  }

  return "OK";
}

function tonerStatusSummary(supplies) {
  if (!supplies.length) {
    return "Not detected";
  }

  const knownSupplies = supplies.filter((supply) => Number.isFinite(supply.percent));

  if (!knownSupplies.length) {
    return "Detected";
  }

  const lowestSupply = knownSupplies.reduce((lowest, supply) => (
    supply.percent < lowest.percent ? supply : lowest
  ), knownSupplies[0]);

  if (lowestSupply.percent <= 10) {
    return `Low: ${lowestSupply.name} ${lowestSupply.percent}%`;
  }

  if (lowestSupply.percent <= 25) {
    return `Check: ${lowestSupply.name} ${lowestSupply.percent}%`;
  }

  return `OK: ${lowestSupply.percent}% min`;
}

function compactDetectedText(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .replace(/\0/g, "")
    .trim();
}

function detectManufacturer(...values) {
  const combined = values.map(compactDetectedText).join(" ").toLowerCase();
  const manufacturers = [
    ["hewlett-packard", "HP"],
    ["hp ", "HP"],
    ["kyocera", "Kyocera"],
    ["zebra", "Zebra"],
    ["oki", "Oki"],
    ["canon", "Canon"],
    ["cannon", "Canon"],
    ["ricoh", "Ricoh"],
    ["brother", "Brother"],
    ["epson", "Epson"],
    ["fuji", "Fuji"],
    ["xerox", "Xerox"],
    ["lexmark", "Lexmark"],
    ["toshiba", "Toshiba"],
    ["konica", "Konica Minolta"],
  ];

  return manufacturers.find(([needle]) => combined.includes(needle))?.[1] || "";
}

function detectModel(sysDescr, printerName, manufacturer) {
  const candidates = [printerName, sysDescr]
    .map(compactDetectedText)
    .filter(Boolean);

  for (const candidate of candidates) {
    const match = candidate.match(
      /\b(?:LaserJet|PageWide|OfficeJet|DesignJet|Color LaserJet|ECOSYS|TASKalfa|ApeosPort|WorkCentre|VersaLink|AltaLink|C[0-9]{4}|E[0-9]{5}[A-Z]*|M[0-9]{3,5}[A-Z]*)\b(?:\s+[A-Z0-9-]+)*/i,
    );

    if (match) {
      return match[0].replace(/\s+/g, " ").trim();
    }
  }

  const fallback = candidates[0] || "";
  const withoutManufacturer = manufacturer
    ? fallback.replace(new RegExp(`\\b${manufacturer}\\b`, "ig"), "")
    : fallback;

  return withoutManufacturer
    .replace(/\b(hewlett-packard|printer|series|embedded|web server|network)\b/ig, "")
    .replace(/[,;].*$/, "")
    .replace(/\s+/g, " ")
    .trim();
}

function detectFormName(sysName, printerName) {
  const candidate = compactDetectedText(sysName) || compactDetectedText(printerName);

  if (!candidate || candidate.toLowerCase() === "unknown") {
    return "";
  }

  return candidate.split(".")[0].toUpperCase();
}

async function detectPrinterProperties(ip) {
  const isOnline = await pingPrinter(ip);
  const detectedAt = new Date().toISOString();

  if (!isOnline) {
    return {
      online: false,
      status: "Offline",
      vncAvailable: false,
      vncCheckedAt: detectedAt,
      statusCheckedAt: detectedAt,
      detectedAt,
      fields: {},
      raw: {},
    };
  }

  const [sysDescr, sysName, printerName, serialNumber, tonerInfo, vncAvailable] = await Promise.all([
    snmpRequest(ip, printerOids.sysDescr),
    snmpRequest(ip, printerOids.sysName),
    snmpRequest(ip, printerOids.printerName),
    snmpRequest(ip, printerOids.serialNumber),
    detectPrinterSupplies(ip),
    checkVncAvailable(ip),
  ]);
  const raw = {
    sysDescr: compactDetectedText(sysDescr?.value),
    sysName: compactDetectedText(sysName?.value),
    printerName: compactDetectedText(printerName?.value),
    serialNumber: compactDetectedText(serialNumber?.value),
  };
  const manufacturer = detectManufacturer(raw.sysDescr, raw.printerName, raw.sysName);
  const model = detectModel(raw.sysDescr, raw.printerName, manufacturer);
  const fields = {
    name: detectFormName(raw.sysName, raw.printerName),
    model,
    serialNo: raw.serialNumber,
    manufacturer,
    status: "Online",
    tonerStatus: tonerInfo.tonerStatus,
    tonerSupplies: tonerInfo.tonerSupplies,
    tonerCheckedAt: detectedAt,
    vncAvailable,
    vncCheckedAt: detectedAt,
    statusCheckedAt: detectedAt,
  };

  return {
    online: true,
    status: "Online",
    vncAvailable,
    vncCheckedAt: detectedAt,
    statusCheckedAt: detectedAt,
    detectedAt,
    fields,
    raw,
  };
}

async function detectPrinterSupplies(ip) {
  const descriptions = await snmpWalk(ip, printerOids.suppliesDescription);

  if (!descriptions.size) {
    return {
      tonerStatus: "Not detected",
      tonerSupplies: [],
    };
  }

  const [maxCapacities, levels] = await Promise.all([
    snmpWalk(ip, printerOids.suppliesMaxCapacity),
    snmpWalk(ip, printerOids.suppliesLevel),
  ]);

  const supplies = [...descriptions.entries()]
    .map(([index, name]) => {
      const max = Number(maxCapacities.get(index));
      const level = Number(levels.get(index));
      const hasPercent = Number.isFinite(max) && max > 0 && Number.isFinite(level) && level >= 0;
      const percent = hasPercent ? Math.max(0, Math.min(100, Math.round((level / max) * 100))) : null;

      return {
        name: String(name || `Supply ${index}`),
        level: Number.isFinite(level) ? level : null,
        max: Number.isFinite(max) ? max : null,
        percent,
        status: supplyLevelStatus(percent),
      };
    })
    .filter((supply) => isTonerSupplyName(supply.name));

  return {
    tonerStatus: tonerStatusSummary(supplies),
    tonerSupplies: supplies,
  };
}

async function mapWithConcurrency(items, limit, mapper) {
  const results = [];
  const executing = new Set();

  for (const item of items) {
    const promise = Promise.resolve().then(() => mapper(item));
    results.push(promise);
    executing.add(promise);

    promise.finally(() => executing.delete(promise));

    if (executing.size >= limit) {
      await Promise.race(executing);
    }
  }

  return Promise.all(results);
}

async function refreshPrinterStatuses() {
  if (statusCheckInProgress) {
    return;
  }

  statusCheckInProgress = true;

  try {
    for (const location of getLocations()) {
      const printers = await readPrinters(location);
      const checkedAt = new Date().toISOString();

      const nextPrinters = await mapWithConcurrency(printers, PING_CONCURRENCY, async (printer) => {
        const isOnline = await pingPrinter(printer.ip);
        const [tonerInfo, vncAvailable] = isOnline
          ? await Promise.all([
              detectPrinterSupplies(printer.ip),
              checkVncAvailable(printer.ip),
            ])
          : [
              {
                tonerStatus: "Unavailable",
                tonerSupplies: [],
              },
              false,
            ];

        return {
          ...printer,
          status: isOnline ? "Online" : "Offline",
          statusCheckedAt: checkedAt,
          tonerStatus: tonerInfo.tonerStatus,
          tonerSupplies: tonerInfo.tonerSupplies,
          tonerCheckedAt: checkedAt,
          vncAvailable,
          vncCheckedAt: checkedAt,
        };
      });

      await writePrinters(location, nextPrinters);
    }
  } catch (error) {
    console.error("Printer status check failed:", error);
  } finally {
    statusCheckInProgress = false;
  }
}
module.exports = {
  checkVncAvailable,
  detectPrinterProperties,
  detectPrinterSupplies,
  pingPrinter,
  refreshPrinterStatuses,
};

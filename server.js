const express = require("express");
const { execFile } = require("node:child_process");
const crypto = require("node:crypto");
const dgram = require("node:dgram");
const fs = require("node:fs/promises");
const http = require("node:http");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { promisify } = require("node:util");

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.join(__dirname, "public", "printerWebsite2");
const DATA_DIR = path.join(__dirname, "data");
const PING_INTERVAL_MS = Number(process.env.PING_INTERVAL_MS) || 5 * 60 * 1000;
const PING_TIMEOUT_MS = Number(process.env.PING_TIMEOUT_MS) || 1000;
const PING_CONCURRENCY = Number(process.env.PING_CONCURRENCY) || 10;
const SNMP_COMMUNITY = process.env.SNMP_COMMUNITY || "public";
const SNMP_TIMEOUT_MS = Number(process.env.SNMP_TIMEOUT_MS) || 1200;
const SNMP_MAX_SUPPLIES = Number(process.env.SNMP_MAX_SUPPLIES) || 40;
const VNC_PORT = Number(process.env.VNC_PORT) || 5900;
const VNC_CONNECT_TIMEOUT_MS = Number(process.env.VNC_CONNECT_TIMEOUT_MS) || 5000;
const VNC_SCAN_TIMEOUT_MS = Number(process.env.VNC_SCAN_TIMEOUT_MS) || 1500;
const DELETE_LOCATION_PIN = process.env.DELETE_LOCATION_PIN || "oldtoy";
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
const activeVncConnections = new Map();

let locations = [];

app.use(express.json());

function findLocation(locationId) {
  return locations.find((location) => location.id === locationId);
}

function locationFilePath(location) {
  return path.join(DATA_DIR, location.file);
}

function slugify(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function displayPathSlug(value) {
  return String(value || "").replace(/[^a-z0-9]/gi, "");
}

function routeKey(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function locationUrlPath(location) {
  return `/${displayPathSlug(location.name)}`;
}

function findLocationByPath(pathValue) {
  const key = routeKey(pathValue);

  if (!key) {
    return null;
  }

  return locations.find((location) => {
    const idKey = routeKey(location.id);
    const nameKey = routeKey(location.name);

    return key === idKey || key === nameKey || nameKey.startsWith(key);
  });
}

async function loadLocationsFromData() {
  const files = await fs.readdir(DATA_DIR);

  locations = [];

  for (const file of files.filter((item) => item.endsWith(".json")).sort()) {
    const filePath = path.join(DATA_DIR, file);
    const data = JSON.parse(await fs.readFile(filePath, "utf8"));

    if (!data.id || !data.name) {
      continue;
    }

    locations.push({
      id: data.id,
      name: data.name,
      file,
      vendor: {
        name: data.vendor?.name || "Cannon",
        phone: data.vendor?.phone || "13 13 83",
      },
    });
  }
}

async function readPrinters(location) {
  const file = await fs.readFile(locationFilePath(location), "utf8");
  const data = JSON.parse(file);

  return Array.isArray(data.printers) ? data.printers : [];
}

async function writePrinters(location, printers) {
  const data = {
    id: location.id,
    name: location.name,
    vendor: location.vendor,
    printers,
  };

  await fs.writeFile(locationFilePath(location), `${JSON.stringify(data, null, 2)}\n`);
}

function sendWebSocketFrame(socket, opcode, payload = Buffer.alloc(0)) {
  if (socket.destroyed) {
    return;
  }

  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  let header;

  if (data.length < 126) {
    header = Buffer.from([0x80 | opcode, data.length]);
  } else if (data.length <= 0xffff) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(data.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(data.length), 2);
  }

  socket.write(Buffer.concat([header, data]));
}

function closeWebSocket(socket, code = 1000, reason = "") {
  if (socket.destroyed) {
    return;
  }

  const reasonBuffer = Buffer.from(reason);
  const payload = Buffer.alloc(2 + reasonBuffer.length);
  payload.writeUInt16BE(code, 0);
  reasonBuffer.copy(payload, 2);
  sendWebSocketFrame(socket, 0x8, payload);
  socket.end();
}

function parseWebSocketFrames(state, chunk, onFrame) {
  state.buffer = Buffer.concat([state.buffer, chunk]);

  while (state.buffer.length >= 2) {
    const firstByte = state.buffer[0];
    const secondByte = state.buffer[1];
    const opcode = firstByte & 0x0f;
    const masked = Boolean(secondByte & 0x80);
    let payloadLength = secondByte & 0x7f;
    let offset = 2;

    if (payloadLength === 126) {
      if (state.buffer.length < offset + 2) {
        return;
      }

      payloadLength = state.buffer.readUInt16BE(offset);
      offset += 2;
    } else if (payloadLength === 127) {
      if (state.buffer.length < offset + 8) {
        return;
      }

      const longPayloadLength = state.buffer.readBigUInt64BE(offset);

      if (longPayloadLength > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new Error("WebSocket frame is too large.");
      }

      payloadLength = Number(longPayloadLength);
      offset += 8;
    }

    const maskLength = masked ? 4 : 0;
    const frameLength = offset + maskLength + payloadLength;

    if (state.buffer.length < frameLength) {
      return;
    }

    const mask = masked ? state.buffer.subarray(offset, offset + 4) : null;
    offset += maskLength;

    const payload = Buffer.from(state.buffer.subarray(offset, offset + payloadLength));
    state.buffer = state.buffer.subarray(frameLength);

    if (mask) {
      for (let index = 0; index < payload.length; index += 1) {
        payload[index] ^= mask[index % 4];
      }
    }

    onFrame(opcode, payload);
  }
}

function handleVncWebSocketUpgrade(req, socket) {
  let tcpSocket = null;

  try {
    const requestUrl = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    const ip = String(requestUrl.searchParams.get("host") || "").trim();
    const port = Number(requestUrl.searchParams.get("port")) || VNC_PORT;
    const webSocketKey = req.headers["sec-websocket-key"];

    if (requestUrl.pathname !== "/api/vnc") {
      socket.destroy();
      return;
    }

    if (!isValidIpAddress(ip) || port !== VNC_PORT || typeof webSocketKey !== "string") {
      socket.destroy();
      return;
    }

    const previousConnection = activeVncConnections.get(ip);

    if (previousConnection) {
      closeWebSocket(previousConnection.socket, 1012, "Another VNC session was opened.");
      previousConnection.tcpSocket?.destroy();
      previousConnection.socket.destroy();
    }

    const activeConnection = {
      socket,
      tcpSocket: null,
    };
    activeVncConnections.set(ip, activeConnection);

    const cleanupConnection = () => {
      if (activeVncConnections.get(ip) === activeConnection) {
        activeVncConnections.delete(ip);
      }
    };

    const acceptKey = crypto
      .createHash("sha1")
      .update(`${webSocketKey}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest("base64");

    socket.write([
      "HTTP/1.1 101 Switching Protocols",
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Accept: ${acceptKey}`,
      "",
      "",
    ].join("\r\n"));

    const frameState = {
      buffer: Buffer.alloc(0),
    };

    tcpSocket = net.createConnection({ host: ip, port });
    activeConnection.tcpSocket = tcpSocket;
    let receivedVncData = false;
    tcpSocket.setTimeout(VNC_CONNECT_TIMEOUT_MS);

    tcpSocket.on("data", (data) => {
      receivedVncData = true;
      tcpSocket.setTimeout(0);
      sendWebSocketFrame(socket, 0x2, data);
    });

    tcpSocket.on("timeout", () => {
      const message = receivedVncData
        ? "VNC server stopped responding."
        : "VNC server accepted the connection but did not send a VNC handshake.";

      closeWebSocket(socket, 1011, message);
      tcpSocket.destroy();
    });

    tcpSocket.on("error", (error) => {
      closeWebSocket(socket, 1011, `Failed to connect to VNC server: ${error.code || error.message}`);
    });

    tcpSocket.on("close", () => {
      cleanupConnection();
      closeWebSocket(socket);
    });

    socket.on("data", (chunk) => {
      try {
        parseWebSocketFrames(frameState, chunk, (opcode, payload) => {
          if (opcode === 0x8) {
            tcpSocket.destroy();
            socket.end();
            return;
          }

          if (opcode === 0x9) {
            sendWebSocketFrame(socket, 0xA, payload);
            return;
          }

          if (opcode === 0x2 || opcode === 0x0) {
            tcpSocket.write(payload);
          }
        });
      } catch (error) {
        console.error("VNC websocket error:", error.message);
        closeWebSocket(socket, 1002, "Invalid websocket frame.");
        tcpSocket.destroy();
      }
    });

    socket.on("error", () => {
      cleanupConnection();
      tcpSocket.destroy();
    });

    socket.on("close", () => {
      cleanupConnection();
      tcpSocket.destroy();
    });
  } catch (error) {
    console.error("VNC websocket upgrade failed:", error);
    tcpSocket?.destroy();
    socket.destroy();
  }
}

function parseJsonArray(value) {
  if (Array.isArray(value)) {
    return value;
  }

  if (typeof value !== "string" || !value.trim()) {
    return [];
  }

  try {
    const parsed = JSON.parse(value);

    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function parseBoolean(value) {
  return value === true || value === "true" || value === "1" || value === 1;
}

function isValidIpAddress(ip) {
  return /^(\d{1,3}\.){3}\d{1,3}$/.test(String(ip || ""));
}

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
    for (const location of locations) {
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

app.get("/api/locations", (req, res) => {
  res.json(
    locations.map(({ id, name, vendor }) => ({
      id,
      name,
      vendor,
      urlPath: locationUrlPath({ name }),
    })),
  );
});

app.post("/api/locations", async (req, res, next) => {
  try {
    const name = String(req.body.name || "").trim();
    const vendorName = String(req.body.vendorName || "Cannon").trim() || "Cannon";
    const vendorPhone = String(req.body.vendorPhone || "13 13 83").trim() || "13 13 83";
    const id = slugify(name);

    if (!name || !id) {
      res.status(400).json({ error: "Location name is required" });
      return;
    }

    if (findLocation(id)) {
      res.status(409).json({ error: "Location already exists" });
      return;
    }

    const location = {
      id,
      name,
      file: `${id}.json`,
      vendor: {
        name: vendorName,
        phone: vendorPhone,
      },
    };

    const filePath = locationFilePath(location);
    const data = {
      id: location.id,
      name: location.name,
      vendor: location.vendor,
      printers: [],
    };

    await fs.writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, { flag: "wx" });
    locations.push(location);

    res.status(201).json({
      id: location.id,
      name: location.name,
      vendor: location.vendor,
      urlPath: locationUrlPath(location),
    });
  } catch (error) {
    next(error);
  }
});

app.delete("/api/locations/:locationId", async (req, res, next) => {
  try {
    const location = findLocation(req.params.locationId);

    if (!location) {
      res.status(404).json({ error: "Location not found" });
      return;
    }

    if (req.body.pin !== DELETE_LOCATION_PIN) {
      res.status(403).json({ error: "Invalid PIN" });
      return;
    }

    await fs.unlink(locationFilePath(location));
    locations = locations.filter((item) => item.id !== location.id);

    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

app.post("/api/printers/check-status", async (req, res, next) => {
  try {
    await refreshPrinterStatuses();
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.post("/api/printers/detect", async (req, res, next) => {
  try {
    const ip = String(req.body.ip || "").trim();

    if (!isValidIpAddress(ip)) {
      res.status(400).json({ error: "Valid IP address is required" });
      return;
    }

    res.json(await detectPrinterProperties(ip));
  } catch (error) {
    next(error);
  }
});

app.get("/api/locations/:locationId/printers", async (req, res, next) => {
  try {
    const location = findLocation(req.params.locationId);

    if (!location) {
      res.status(404).json({ error: "Location not found" });
      return;
    }

    res.json({
      id: location.id,
      name: location.name,
      vendor: location.vendor,
      printers: await readPrinters(location),
    });
  } catch (error) {
    next(error);
  }
});

app.post("/api/locations/:locationId/printers", async (req, res, next) => {
  try {
    const location = findLocation(req.params.locationId);

    if (!location) {
      res.status(404).json({ error: "Location not found" });
      return;
    }

    const now = new Date().toISOString();
    const printer = {
      id: req.body.id || randomUUID(),
      name: req.body.name || "",
      ip: req.body.ip || "",
      model: req.body.model || "",
      machineNo: req.body.machineNo || "",
      serialNo: req.body.serialNo || "",
      location: req.body.location || "",
      department: req.body.department || "",
      manufacturer: req.body.manufacturer || "",
      status: req.body.status || "Unknown",
      tonerStatus: req.body.tonerStatus || "Unknown",
      tonerSupplies: parseJsonArray(req.body.tonerSupplies),
      tonerCheckedAt: req.body.tonerCheckedAt || "",
      vncAvailable: parseBoolean(req.body.vncAvailable),
      vncCheckedAt: req.body.vncCheckedAt || "",
      statusCheckedAt: req.body.statusCheckedAt || "",
      createdAt: now,
      updatedAt: now,
    };

    const printers = await readPrinters(location);
    printers.push(printer);
    await writePrinters(location, printers);

    res.status(201).json(printer);
  } catch (error) {
    next(error);
  }
});

app.put("/api/locations/:locationId/printers/:printerId", async (req, res, next) => {
  try {
    const location = findLocation(req.params.locationId);

    if (!location) {
      res.status(404).json({ error: "Location not found" });
      return;
    }

    const printers = await readPrinters(location);
    const printerIndex = printers.findIndex((printer) => printer.id === req.params.printerId);

    if (printerIndex === -1) {
      res.status(404).json({ error: "Printer not found" });
      return;
    }

    const tonerSupplies = parseJsonArray(req.body.tonerSupplies);

    printers[printerIndex] = {
      ...printers[printerIndex],
      name: req.body.name || "",
      ip: req.body.ip || "",
      model: req.body.model || "",
      machineNo: req.body.machineNo || "",
      serialNo: req.body.serialNo || "",
      location: req.body.location || "",
      department: req.body.department || "",
      manufacturer: req.body.manufacturer || "",
      status: req.body.status || "Unknown",
      tonerStatus: req.body.tonerStatus || printers[printerIndex].tonerStatus || "Unknown",
      tonerSupplies: tonerSupplies.length ? tonerSupplies : printers[printerIndex].tonerSupplies || [],
      tonerCheckedAt: req.body.tonerCheckedAt || printers[printerIndex].tonerCheckedAt || "",
      vncAvailable: req.body.vncAvailable === undefined
        ? Boolean(printers[printerIndex].vncAvailable)
        : parseBoolean(req.body.vncAvailable),
      vncCheckedAt: req.body.vncCheckedAt || printers[printerIndex].vncCheckedAt || "",
      statusCheckedAt: req.body.statusCheckedAt || printers[printerIndex].statusCheckedAt || "",
      updatedAt: new Date().toISOString(),
    };

    await writePrinters(location, printers);
    res.json(printers[printerIndex]);
  } catch (error) {
    next(error);
  }
});

app.delete("/api/locations/:locationId/printers/:printerId", async (req, res, next) => {
  try {
    const location = findLocation(req.params.locationId);

    if (!location) {
      res.status(404).json({ error: "Location not found" });
      return;
    }

    const printers = await readPrinters(location);
    const nextPrinters = printers.filter((printer) => printer.id !== req.params.printerId);

    if (nextPrinters.length === printers.length) {
      res.status(404).json({ error: "Printer not found" });
      return;
    }

    await writePrinters(location, nextPrinters);
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

app.use(express.static(PUBLIC_DIR));

app.get("/", (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "index.html"));
});

app.get("/:locationPath", (req, res, next) => {
  const location = findLocationByPath(req.params.locationPath);

  if (!location) {
    next();
    return;
  }

  res.sendFile(path.join(PUBLIC_DIR, "index.html"));
});

app.use((req, res) => {
  res.status(404).send("Not found");
});

app.use((error, req, res, next) => {
  console.error(error);
  res.status(500).json({ error: "Internal server error" });
});

async function startServer() {
  await loadLocationsFromData();

  const server = http.createServer(app);

  server.on("upgrade", (req, socket) => {
    if (req.url?.startsWith("/api/vnc")) {
      handleVncWebSocketUpgrade(req, socket);
      return;
    }

    socket.destroy();
  });

  server.listen(PORT, () => {
    console.log(`Printer website server running at http://localhost:${PORT}`);
    console.log(`Printer status checks running every ${Math.round(PING_INTERVAL_MS / 1000)} seconds`);
  });

  setTimeout(refreshPrinterStatuses, 1000);
  setInterval(refreshPrinterStatuses, PING_INTERVAL_MS);
}

startServer().catch((error) => {
  console.error(error);
  process.exit(1);
});

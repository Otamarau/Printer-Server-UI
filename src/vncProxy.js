const crypto = require("node:crypto");
const net = require("node:net");

const { VNC_CONNECT_TIMEOUT_MS, VNC_PORT } = require("./config");
const { isValidIpAddress } = require("./utils");

const activeVncConnections = new Map();
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
module.exports = {
  handleVncWebSocketUpgrade,
};

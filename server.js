const express = require("express");
const fsSync = require("node:fs");
const http = require("node:http");
const https = require("node:https");
const path = require("node:path");

const {
  BACKUP_INTERVAL_MS,
  DRIVER_UPLOAD_JSON_LIMIT,
  HTTPS_CERT_FILE,
  HTTPS_KEY_FILE,
  PING_INTERVAL_MS,
  PORT,
} = require("./src/config");
const { runScheduledBackup } = require("./src/backups");
const { refreshPrinterStatuses } = require("./src/printerDetection");
const { registerRoutes } = require("./src/routes");
const { loadLocationsFromData } = require("./src/store");
const { handleVncWebSocketUpgrade } = require("./src/vncProxy");

const app = express();

app.use("/api/drivers", express.json({ limit: DRIVER_UPLOAD_JSON_LIMIT }));
app.use(express.json());
registerRoutes(app);

async function startServer() {
  await loadLocationsFromData();

  const useHttps = Boolean(HTTPS_CERT_FILE && HTTPS_KEY_FILE);
  const server = useHttps
    ? https.createServer({
      cert: fsSync.readFileSync(path.resolve(HTTPS_CERT_FILE)),
      key: fsSync.readFileSync(path.resolve(HTTPS_KEY_FILE)),
    }, app)
    : http.createServer(app);

  server.on("upgrade", (req, socket) => {
    if (req.url?.startsWith("/api/vnc")) {
      handleVncWebSocketUpgrade(req, socket);
      return;
    }

    socket.destroy();
  });

  server.listen(PORT, () => {
    const protocol = useHttps ? "https" : "http";

    console.log(`Printer website server running at ${protocol}://localhost:${PORT}`);
    if (!useHttps) {
      console.log("Password-protected noVNC sessions require HTTPS or localhost in modern browsers.");
    }
    console.log(`Printer status checks running every ${Math.round(PING_INTERVAL_MS / 1000)} seconds`);
    console.log(`JSON data backups running every ${Math.round(BACKUP_INTERVAL_MS / 1000)} seconds`);
  });

  setTimeout(runScheduledBackup, 5000);
  setInterval(runScheduledBackup, BACKUP_INTERVAL_MS);
  setTimeout(refreshPrinterStatuses, 1000);
  setInterval(refreshPrinterStatuses, PING_INTERVAL_MS);
}

startServer().catch((error) => {
  console.error(error);
  process.exit(1);
});

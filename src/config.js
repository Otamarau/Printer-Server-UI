const fsSync = require("node:fs");
const path = require("node:path");

const APP_ROOT = path.resolve(__dirname, "..");
const CONFIG_FILE = process.env.CONFIG_FILE
  ? path.resolve(process.env.CONFIG_FILE)
  : path.join(APP_ROOT, "config.json");
const CONFIG_EXAMPLE_FILE = path.join(APP_ROOT, "config.example.json");

function loadConfig(filePath) {
  try {
    return JSON.parse(fsSync.readFileSync(filePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") {
      if (!process.env.CONFIG_FILE && fsSync.existsSync(CONFIG_EXAMPLE_FILE)) {
        fsSync.copyFileSync(CONFIG_EXAMPLE_FILE, filePath);
        return JSON.parse(fsSync.readFileSync(filePath, "utf8"));
      }

      return {};
    }

    throw new Error(`Unable to load config file at ${filePath}: ${error.message}`);
  }
}

const config = loadConfig(CONFIG_FILE);
const PORT = Number(process.env.PORT) || 3000;
const HTTPS_CERT_FILE = process.env.HTTPS_CERT_FILE || config.httpsCertFile || "";
const HTTPS_KEY_FILE = process.env.HTTPS_KEY_FILE || config.httpsKeyFile || "";
const PUBLIC_DIR = path.join(APP_ROOT, "public", "printerWebsite2");
const DATA_DIR = path.join(APP_ROOT, "data");
const DRIVERS_DIR = path.join(APP_ROOT, "drivers");
const DRIVER_INDEX_FILE = path.join(DRIVERS_DIR, "index.json");
const BACKUP_DIR = process.env.BACKUP_DIR
  ? path.resolve(process.env.BACKUP_DIR)
  : path.join(DATA_DIR, "backups");
const BACKUP_INTERVAL_MS = Number(process.env.BACKUP_INTERVAL_MS || config.backupIntervalMs) || 24 * 60 * 60 * 1000;
const BACKUP_RETENTION_COUNT = Number(process.env.BACKUP_RETENTION_COUNT || config.backupRetentionCount) || 30;
const PING_INTERVAL_MS = Number(process.env.PING_INTERVAL_MS) || 5 * 60 * 1000;
const PING_TIMEOUT_MS = Number(process.env.PING_TIMEOUT_MS) || 1000;
const PING_CONCURRENCY = Number(process.env.PING_CONCURRENCY) || 10;
const SNMP_COMMUNITY = process.env.SNMP_COMMUNITY || "public";
const SNMP_TIMEOUT_MS = Number(process.env.SNMP_TIMEOUT_MS) || 1200;
const SNMP_MAX_SUPPLIES = Number(process.env.SNMP_MAX_SUPPLIES) || 40;
const VNC_PORT = Number(process.env.VNC_PORT) || 5900;
const VNC_CONNECT_TIMEOUT_MS = Number(process.env.VNC_CONNECT_TIMEOUT_MS) || 5000;
const VNC_SCAN_TIMEOUT_MS = Number(process.env.VNC_SCAN_TIMEOUT_MS) || 1500;
const DRIVER_UPLOAD_JSON_LIMIT = process.env.DRIVER_UPLOAD_JSON_LIMIT
  || config.driverUploadJsonLimit
  || "150mb";
const DELETE_LOCATION_PIN = process.env.DELETE_LOCATION_PIN || config.deleteLocationPin;

module.exports = {
  APP_ROOT,
  BACKUP_DIR,
  BACKUP_INTERVAL_MS,
  BACKUP_RETENTION_COUNT,
  DATA_DIR,
  DELETE_LOCATION_PIN,
  DRIVER_INDEX_FILE,
  DRIVER_UPLOAD_JSON_LIMIT,
  DRIVERS_DIR,
  HTTPS_CERT_FILE,
  HTTPS_KEY_FILE,
  PING_CONCURRENCY,
  PING_INTERVAL_MS,
  PING_TIMEOUT_MS,
  PORT,
  PUBLIC_DIR,
  SNMP_COMMUNITY,
  SNMP_MAX_SUPPLIES,
  SNMP_TIMEOUT_MS,
  VNC_CONNECT_TIMEOUT_MS,
  VNC_PORT,
  VNC_SCAN_TIMEOUT_MS,
};

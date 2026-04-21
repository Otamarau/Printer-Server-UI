const express = require("express");
const { execFile } = require("node:child_process");
const fs = require("node:fs/promises");
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
const DELETE_LOCATION_PIN = process.env.DELETE_LOCATION_PIN || "oldtoy";
const execFileAsync = promisify(execFile);
const isWindows = os.platform() === "win32";

let statusCheckInProgress = false;

let locations = [
  {
    id: "springwood-toyota",
    name: "Springwood Toyota",
    file: "springwood-toyota.json",
    vendor: {
      name: "Cannon",
      phone: "13 13 83",
    },
  },
  {
    id: "springwood-mazda-sales",
    name: "Springwood Mazda Sales",
    file: "springwood-mazda-sales.json",
    vendor: {
      name: "Cannon",
      phone: "13 13 83",
    },
  },
  {
    id: "springwood-mazda-service",
    name: "Springwood Mazda Service",
    file: "springwood-mazda-service.json",
    vendor: {
      name: "Cannon",
      phone: "13 13 83",
    },
  },
  {
    id: "cleveland-toyota",
    name: "Cleveland Toyota",
    file: "cleveland-toyota.json",
    vendor: {
      name: "Cannon",
      phone: "13 13 83",
    },
  },
  {
    id: "redlands-mazda",
    name: "Redlands Mazda",
    file: "redlands-mazda.json",
    vendor: {
      name: "Cannon",
      phone: "13 13 83",
    },
  },
  {
    id: "kingstine-pd",
    name: "Kingstine PD",
    file: "kingstine-pd.json",
    vendor: {
      name: "Cannon",
      phone: "13 13 83",
    },
  },
];

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
  const defaultsById = new Map(locations.map((location) => [location.id, location]));
  const loadedLocations = [];

  for (const file of files.filter((item) => item.endsWith(".json"))) {
    const filePath = path.join(DATA_DIR, file);
    const data = JSON.parse(await fs.readFile(filePath, "utf8"));

    if (!data.id || !data.name) {
      continue;
    }

    const defaultLocation = defaultsById.get(data.id);
    loadedLocations.push({
      id: data.id,
      name: data.name,
      file,
      vendor: {
        name: data.vendor?.name || defaultLocation?.vendor.name || "Cannon",
        phone: data.vendor?.phone || defaultLocation?.vendor.phone || "13 13 83",
      },
    });
  }

  locations = [
    ...locations
      .map((location) => loadedLocations.find((loadedLocation) => loadedLocation.id === location.id) || location),
    ...loadedLocations.filter((location) => !defaultsById.has(location.id)),
  ];
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

        return {
          ...printer,
          status: isOnline ? "Online" : "Offline",
          statusCheckedAt: checkedAt,
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

  app.listen(PORT, () => {
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

const express = require("express");
const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

const {
  APP_ROOT,
  DELETE_LOCATION_PIN,
  DRIVER_UPLOAD_JSON_LIMIT,
  DRIVERS_DIR,
  PUBLIC_DIR,
} = require("./config");
const {
  addLocation,
  findLocation,
  findLocationByPath,
  getLocations,
  latestDriverForPrinter,
  locationFilePath,
  locationUrlPath,
  readDriverIndex,
  readKnownPrinterModels,
  readPrinters,
  removeLocation,
  writeDriverIndex,
  writePrinters,
} = require("./store");
const { detectPrinterProperties, refreshPrinterStatuses } = require("./printerDetection");
const {
  normalizeModelKey,
  parseBoolean,
  parseJsonArray,
  safeFileSegment,
  slugify,
} = require("./utils");

function registerRoutes(app) {
app.get("/api/locations", (req, res) => {
  res.json(
    getLocations().map(({ id, name, vendor }) => ({
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
    addLocation(location);

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

    if (!DELETE_LOCATION_PIN) {
      res.status(503).json({ error: "Delete location PIN is not configured" });
      return;
    }

    if (req.body.pin !== DELETE_LOCATION_PIN) {
      res.status(403).json({ error: "Invalid PIN" });
      return;
    }

    await fs.unlink(locationFilePath(location));
    removeLocation(location.id);

    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

app.put("/api/locations/:locationId/vendor", async (req, res, next) => {
  try {
    const location = findLocation(req.params.locationId);

    if (!location) {
      res.status(404).json({ error: "Location not found" });
      return;
    }

    const vendorName = String(req.body.vendorName || "").trim();
    const vendorPhone = String(req.body.vendorPhone || "").trim();

    if (!vendorName || !vendorPhone) {
      res.status(400).json({ error: "Vendor name and phone are required" });
      return;
    }

    const printers = await readPrinters(location);

    location.vendor = {
      name: vendorName,
      phone: vendorPhone,
    };

    await writePrinters(location, printers);

    res.json({
      id: location.id,
      name: location.name,
      vendor: location.vendor,
      urlPath: locationUrlPath(location),
    });
  } catch (error) {
    next(error);
  }
});

app.get("/api/locations/:locationId/download", (req, res, next) => {
  const location = findLocation(req.params.locationId);

  if (!location) {
    res.status(404).json({ error: "Location not found" });
    return;
  }

  res.download(locationFilePath(location), location.file, (error) => {
    if (error && !res.headersSent) {
      next(error);
    }
  });
});

app.get("/api/printer-models", async (req, res, next) => {
  try {
    res.json({
      models: await readKnownPrinterModels(),
    });
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

app.post("/api/drivers", async (req, res, next) => {
  try {
    const model = String(req.body.model || "").trim();
    const fileName = path.basename(String(req.body.fileName || "").trim());
    const contentType = String(req.body.contentType || "application/octet-stream").trim();
    const version = String(req.body.version || "").trim();
    const notes = String(req.body.notes || "").trim();
    const fileData = String(req.body.fileData || "");

    if (!model) {
      res.status(400).json({ error: "Printer model is required" });
      return;
    }

    if (!fileName || !fileData.startsWith("data:")) {
      res.status(400).json({ error: "Driver file is required" });
      return;
    }

    const knownModels = new Set(
      (await readKnownPrinterModels()).map((knownModel) => normalizeModelKey(knownModel)),
    );

    if (!knownModels.has(normalizeModelKey(model))) {
      res.status(400).json({ error: "Printer model must match one of the listed models" });
      return;
    }

    const dataUrlMatch = fileData.match(/^data:([^;,]+)?;base64,(.+)$/);

    if (!dataUrlMatch) {
      res.status(400).json({ error: "Driver file data is invalid" });
      return;
    }

    const modelDirName = safeFileSegment(model, "model");
    const targetDir = path.join(DRIVERS_DIR, modelDirName);
    const targetFileName = `${Date.now()}-${safeFileSegment(fileName)}`;
    const targetPath = path.join(targetDir, targetFileName);
    const buffer = Buffer.from(dataUrlMatch[2], "base64");
    const now = new Date().toISOString();

    await fs.mkdir(targetDir, { recursive: true });
    await fs.writeFile(targetPath, buffer);

    const drivers = await readDriverIndex();
    const driverRecord = {
      id: randomUUID(),
      model,
      version,
      notes,
      fileName,
      storedFileName: targetFileName,
      contentType,
      fileSize: buffer.length,
      relativePath: path.relative(APP_ROOT, targetPath).replace(/\\/g, "/"),
      createdAt: now,
    };

    drivers.push(driverRecord);
    await writeDriverIndex(drivers);

    res.status(201).json(driverRecord);
  } catch (error) {
    next(error);
  }
});

app.get("/api/drivers/:driverId/download", async (req, res, next) => {
  try {
    const drivers = await readDriverIndex();
    const driver = drivers.find((item) => item.id === req.params.driverId);

    if (!driver) {
      res.status(404).json({ error: "Driver not found" });
      return;
    }

    const absolutePath = path.resolve(APP_ROOT, driver.relativePath || "");

    if (!absolutePath.startsWith(path.resolve(DRIVERS_DIR))) {
      res.status(400).json({ error: "Driver path is invalid" });
      return;
    }

    res.download(absolutePath, driver.fileName, (error) => {
      if (error && !res.headersSent) {
        next(error);
      }
    });
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

    const [printers, drivers] = await Promise.all([
      readPrinters(location),
      readDriverIndex(),
    ]);
    const printersWithDrivers = printers.map((printer) => {
      const driver = latestDriverForPrinter(drivers, printer.model);

      return {
        ...printer,
        driver: driver
          ? {
              id: driver.id,
              fileName: driver.fileName,
              version: driver.version,
              notes: driver.notes,
              createdAt: driver.createdAt,
              downloadUrl: `/api/drivers/${encodeURIComponent(driver.id)}/download`,
            }
          : null,
      };
    });

    res.json({
      id: location.id,
      name: location.name,
      vendor: location.vendor,
      printers: printersWithDrivers,
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
  if (error.type === "entity.too.large") {
    res.status(413).json({
      error: `Request body is too large. Driver uploads are limited to ${DRIVER_UPLOAD_JSON_LIMIT}.`,
    });
    return;
  }

  console.error(error);
  res.status(500).json({ error: "Internal server error" });
});
}

module.exports = {
  registerRoutes,
};

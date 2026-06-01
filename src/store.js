const fs = require("node:fs/promises");
const path = require("node:path");

const { DATA_DIR, DRIVERS_DIR, DRIVER_INDEX_FILE } = require("./config");
const { displayPathSlug, normalizeModelKey, routeKey } = require("./utils");

let locations = [];

function getLocations() {
  return locations;
}

function addLocation(location) {
  locations.push(location);
}

function removeLocation(locationId) {
  locations = locations.filter((item) => item.id !== locationId);
}
function findLocation(locationId) {
  return locations.find((location) => location.id === locationId);
}

function locationFilePath(location) {
  return path.join(DATA_DIR, location.file);
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
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.mkdir(DRIVERS_DIR, { recursive: true });

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

async function readDriverIndex() {
  try {
    const file = await fs.readFile(DRIVER_INDEX_FILE, "utf8");
    const data = JSON.parse(file);

    return Array.isArray(data.drivers) ? data.drivers : [];
  } catch (error) {
    if (error.code === "ENOENT") {
      return [];
    }

    throw error;
  }
}

async function writeDriverIndex(drivers) {
  await fs.mkdir(DRIVERS_DIR, { recursive: true });
  await fs.writeFile(DRIVER_INDEX_FILE, `${JSON.stringify({ drivers }, null, 2)}\n`);
}

function latestDriverForPrinter(drivers, model) {
  const modelKey = normalizeModelKey(model);

  if (!modelKey) {
    return null;
  }

  const matches = drivers
    .filter((driver) => normalizeModelKey(driver.model) === modelKey)
    .sort((left, right) => String(right.createdAt || "").localeCompare(String(left.createdAt || "")));

  return matches[0] || null;
}

async function readKnownPrinterModels() {
  const modelMap = new Map();

  for (const location of locations) {
    const printers = await readPrinters(location);

    for (const printer of printers) {
      const model = String(printer.model || "").trim();
      const modelKey = normalizeModelKey(model);

      if (model && modelKey && !modelMap.has(modelKey)) {
        modelMap.set(modelKey, model);
      }
    }
  }

  return [...modelMap.values()].sort((left, right) => left.localeCompare(right));
}

module.exports = {
  addLocation,
  findLocation,
  findLocationByPath,
  getLocations,
  latestDriverForPrinter,
  loadLocationsFromData,
  locationFilePath,
  locationUrlPath,
  readDriverIndex,
  readKnownPrinterModels,
  readPrinters,
  removeLocation,
  writeDriverIndex,
  writePrinters,
};

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

function safeFileSegment(value, fallback = "file") {
  const normalized = String(value || "")
    .trim()
    .replace(/[^a-z0-9._-]+/gi, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");

  return normalized || fallback;
}

function normalizeModelKey(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
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

module.exports = {
  displayPathSlug,
  isValidIpAddress,
  normalizeModelKey,
  parseBoolean,
  parseJsonArray,
  routeKey,
  safeFileSegment,
  slugify,
};

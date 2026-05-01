const locationContainer = document.querySelector("#location-row-con");
const mobileLocationButton = document.querySelector("#mobile-location-button");
const mobileLocationMenu = document.querySelector("#mobile-location-menu");
const vendorTitle = document.querySelector("#vendor-title");
const addPrinterButton = document.querySelector("#add-printer-button");
const addDriverButton = document.querySelector("#add-driver-button");
const addLocationButton = document.querySelector("#add-location-button");
const darkModeButton = document.querySelector("#dark-mode-button");
const tableContainer = document.querySelector("#table-con");

let locations = [];
let activeLocationId = "";
let printers = [];
let currentView = "table";
let rfbClient = null;
let noVncModulePromise = null;
let lastVncFailureReason = "";
let vncFramebufferUpdates = 0;
let vncConnectedAt = 0;
let vncFrameKickTimer = null;

const fields = [
  { key: "name", label: "Name", placeholder: "Enter name" },
  { key: "ip", label: "IP Address", placeholder: "Enter IP address" },
  { key: "model", label: "Model", placeholder: "Enter model" },
  { key: "machineNo", label: "Machine Number", placeholder: "Enter machine number" },
  { key: "serialNo", label: "Serial Number", placeholder: "Enter serial number" },
  { key: "location", label: "Location", placeholder: "Enter location" },
  { key: "department", label: "Department", placeholder: "Enter department" },
  { key: "manufacturer", label: "Manufacturer", placeholder: "Enter manufacturer" },
  { key: "status", label: "Status", placeholder: "Enter status" },
];

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function activeLocation() {
  return locations.find((location) => location.id === activeLocationId);
}

function routeKey(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function locationUrlPath(location) {
  return location.urlPath || `/${String(location.name || "").replace(/[^a-z0-9]/gi, "")}`;
}

function findLocationFromPath() {
  const pathValue = decodeURIComponent(window.location.pathname).replace(/^\/+|\/+$/g, "");
  const key = routeKey(pathValue);

  if (!key) {
    return null;
  }

  return locations.find((location) => {
    const idKey = routeKey(location.id);
    const nameKey = routeKey(location.name);

    return key === idKey || key === nameKey || nameKey.startsWith(key);
  }) || null;
}

function setLocationPath(locationId, replace = false) {
  const location = locations.find((item) => item.id === locationId);

  if (!location) {
    return;
  }

  const nextPath = locationUrlPath(location);

  if (window.location.pathname === nextPath) {
    return;
  }

  const method = replace ? "replaceState" : "pushState";
  window.history[method]({ locationId }, "", nextPath);
}

function applyDarkMode(isDarkMode) {
  document.body.classList.toggle("dark-mode", isDarkMode);
  darkModeButton.innerHTML = isDarkMode
    ? '<i class="fa-solid fa-sun"></i>'
    : '<i class="fa-solid fa-moon"></i>';
  darkModeButton.setAttribute("aria-pressed", String(isDarkMode));
  localStorage.setItem("printerManagerDarkMode", String(isDarkMode));
}

function statusBadge(status) {
  const statusText = String(status || "Unknown");
  const statusClass = statusText.toLowerCase() === "online"
    ? "bg-success"
    : statusText.toLowerCase() === "offline"
      ? "bg-danger"
      : "bg-secondary";

  return `<span class="badge ${statusClass}">${escapeHtml(statusText)}</span>`;
}

function tonerBadge(status) {
  const statusText = String(status || "Unknown");
  const statusClass = statusText.toLowerCase().startsWith("low")
    ? "bg-danger"
    : statusText.toLowerCase().startsWith("check")
      ? "bg-warning text-dark"
      : statusText.toLowerCase().startsWith("ok")
        ? "bg-success"
        : "bg-secondary";

  return `<span class="badge ${statusClass}">${escapeHtml(statusText)}</span>`;
}

function statusCheckedTitle(printer) {
  if (!printer.statusCheckedAt) {
    return "";
  }

  const checkedAt = new Date(printer.statusCheckedAt).toLocaleString();

  return ` title="Last checked ${escapeHtml(checkedAt)}"`;
}

function tonerCheckedTitle(printer) {
  if (!printer.tonerCheckedAt && !printer.tonerSupplies?.length) {
    return "";
  }

  const supplyLines = Array.isArray(printer.tonerSupplies)
    ? printer.tonerSupplies.map((supply) => {
        const level = Number.isFinite(supply.percent) ? `${supply.percent}%` : "level unknown";

        return `${supply.name}: ${level}`;
      })
    : [];
  const checkedAt = printer.tonerCheckedAt
    ? `Last checked ${new Date(printer.tonerCheckedAt).toLocaleString()}`
    : "";
  const title = [...supplyLines, checkedAt].filter(Boolean).join("\n");

  return title ? ` title="${escapeHtml(title)}"` : "";
}

function renderVncCell(printer) {
  if (!printer.vncAvailable) {
    return "";
  }

  return `
    <button type="button" class="btn btn-outline-primary open-vnc-button" data-printer-ip="${escapeHtml(printer.ip)}" data-printer-name="${escapeHtml(printer.name)}" title="Open browser VNC">
      <i class="fa-solid fa-display"></i>
    </button>
  `;
}

function driverTitle(printer) {
  if (!printer.driver) {
    return "";
  }

  const details = [
    printer.driver.fileName,
    printer.driver.version ? `Version: ${printer.driver.version}` : "",
    printer.driver.createdAt ? `Uploaded: ${new Date(printer.driver.createdAt).toLocaleString()}` : "",
    printer.driver.notes || "",
  ].filter(Boolean).join("\n");

  return details ? ` title="${escapeHtml(details)}"` : "";
}

function renderDriverCell(printer) {
  if (!printer.driver?.downloadUrl) {
    return "";
  }

  return `
    <a
      class="btn btn-outline-secondary download-driver-button"
      href="${escapeHtml(printer.driver.downloadUrl)}"
      ${driverTitle(printer)}
      aria-label="Download driver"
    >
      <i class="fa-solid fa-download"></i>
    </a>
  `;
}

function setInputValue(form, name, value, options = {}) {
  const input = form.elements[name];

  if (!input || value === undefined || value === null || value === "") {
    return false;
  }

  if (options.onlyIfEmpty && input.value.trim()) {
    return false;
  }

  input.value = typeof value === "string" ? value : JSON.stringify(value);
  return true;
}

function renderSiteLocationSelect(selectedLocationId) {
  return `
    <div class="form-group">
      <label for="siteLocationId">Site</label>
      <select class="form-select" id="siteLocationId" name="siteLocationId">
        ${locations
          .map(
            (location) => `
              <option value="${escapeHtml(location.id)}" ${location.id === selectedLocationId ? "selected" : ""}>
                ${escapeHtml(location.name)}
              </option>
            `,
          )
          .join("")}
      </select>
    </div>
  `;
}

function availablePrinterModels() {
  return [...new Set(
    printers
      .map((printer) => String(printer.model || "").trim())
      .filter(Boolean),
  )].sort((left, right) => left.localeCompare(right));
}

function renderDriverModelSelect() {
  const models = availablePrinterModels();

  if (!models.length) {
    return `
      <div class="form-group">
        <label for="driverModel">Printer Model</label>
        <input
          type="text"
          class="form-control"
          id="driverModel"
          name="model"
          placeholder="No printer models found for this location"
          disabled
        >
      </div>
    `;
  }

  return `
    <div class="form-group">
      <label for="driverModel">Printer Model</label>
      <select class="form-select" id="driverModel" name="model" required>
        <option value="">Select a printer model</option>
        ${models
          .map((model) => `<option value="${escapeHtml(model)}">${escapeHtml(model)}</option>`)
          .join("")}
      </select>
    </div>
  `;
}

async function apiRequest(url, options = {}) {
  const response = await fetch(url, {
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
    ...options,
  });

  if (!response.ok) {
    throw new Error(`Request failed with ${response.status}`);
  }

  if (response.status === 204) {
    return null;
  }

  return response.json();
}

function renderLocations() {
  locationContainer.innerHTML = locations
    .map(
      (location) => `
        <button class="location-row ${location.id === activeLocationId ? "active" : ""}" type="button" data-location-id="${location.id}">
          <h2>${escapeHtml(location.name)}</h2>
        </button>
      `,
    )
    .join("");
  const currentLocation = activeLocation();

  mobileLocationButton.textContent = currentLocation?.name || (locations.length ? "Choose location" : "No locations");
  mobileLocationButton.disabled = !locations.length;
  mobileLocationMenu.innerHTML = locations.length
    ? locations
        .map(
          (location) => `
            <button
              class="mobile-location-option ${location.id === activeLocationId ? "active" : ""}"
              type="button"
              data-location-id="${escapeHtml(location.id)}"
            >
              ${escapeHtml(location.name)}
            </button>
          `,
        )
        .join("")
    : '<span class="mobile-location-empty">No locations</span>';
  addLocationButton.parentElement.classList.remove("active");

  locationContainer.querySelectorAll(".location-row").forEach((button) => {
    button.addEventListener("click", () => loadPrinters(button.dataset.locationId));
  });

  mobileLocationMenu.querySelectorAll(".mobile-location-option").forEach((button) => {
    button.addEventListener("click", () => {
      closeMobileLocationMenu();
      loadPrinters(button.dataset.locationId).catch(console.error);
    });
  });
}

function closeMobileLocationMenu() {
  mobileLocationMenu.hidden = true;
  mobileLocationButton.setAttribute("aria-expanded", "false");
}

function toggleMobileLocationMenu() {
  const isOpen = !mobileLocationMenu.hidden;

  mobileLocationMenu.hidden = isOpen;
  mobileLocationButton.setAttribute("aria-expanded", String(!isOpen));
}

function renderVendor() {
  const location = activeLocation();

  if (!location) {
    vendorTitle.textContent = "Vendor: Unknown";
    return;
  }

  vendorTitle.textContent = `Vendor: ${location.vendor.name}, Phone: ${location.vendor.phone}`;
}

function renderTable() {
  currentView = "table";

  if (!printers.length) {
    tableContainer.innerHTML = `
      <div class="table-view">
        <div class="empty-state">
          <h2>No printers found for this location.</h2>
        </div>
        ${renderTableActions()}
      </div>
    `;
    attachTableActions();
    return;
  }

  tableContainer.innerHTML = `
    <div class="table-view">
      <table class="table table-striped table-hover">
        <thead>
          <tr>
            <th scope="col">Name</th>
            <th scope="col">IP</th>
            <th scope="col">Model</th>
            <th scope="col">SerialNO</th>
            <th scope="col">Location</th>
            <th scope="col">Department</th>
            <th scope="col">Manufacturer</th>
            <th scope="col">Status</th>
            <th scope="col" class="toner-col">Toner</th>
            <th scope="col" class="driver-col">Driver</th>
            <th scope="col" class="vnc-col">VNC</th>
            <th scope="col" class="action-col"></th>
          </tr>
        </thead>
        <tbody>
          ${printers
            .map(
              (printer) => `
                <tr>
                  <th scope="row" data-label="Name">${escapeHtml(printer.name)}</th>
                  <td data-label="IP"><a href="http://${escapeHtml(printer.ip)}" target="_blank" rel="noreferrer">${escapeHtml(printer.ip)}</a></td>
                  <td data-label="Model">${escapeHtml(printer.model)}</td>
                  <td data-label="SerialNO">${escapeHtml(printer.serialNo)}</td>
                  <td data-label="Location">${escapeHtml(printer.location)}</td>
                  <td data-label="Department">${escapeHtml(printer.department)}</td>
                  <td data-label="Manufacturer">${escapeHtml(printer.manufacturer)}</td>
                  <td data-label="Status"${statusCheckedTitle(printer)}>${statusBadge(printer.status)}</td>
                  <td data-label="Toner" class="toner-cell"${tonerCheckedTitle(printer)}>${tonerBadge(printer.tonerStatus)}</td>
                  <td data-label="Driver" class="driver-cell">${renderDriverCell(printer)}</td>
                  <td data-label="VNC" class="vnc-cell">${renderVncCell(printer)}</td>
                  <td data-label="Edit" class="action-cell">
                    <button type="button" class="btn btn-success edit-printer-button" data-printer-id="${printer.id}" title="Edit printer">
                      <i class="fa-solid fa-pen"></i>
                    </button>
                  </td>
                </tr>
              `,
            )
            .join("")}
        </tbody>
      </table>
      ${renderTableActions()}
    </div>
  `;

  document.querySelectorAll(".edit-printer-button").forEach((button) => {
    button.addEventListener("click", () => renderForm(button.dataset.printerId));
  });
  document.querySelectorAll(".open-vnc-button").forEach((button) => {
    button.addEventListener("click", () => openVnc(button.dataset.printerIp, button.dataset.printerName, button));
  });
  attachTableActions();
}

function renderTableActions() {
  return `
    <div class="table-actions">
      <button type="button" class="btn btn-primary" id="update-vendor-button">Update Vendor</button>
      <button type="button" class="btn btn-info" id="download-location-button">Download Location</button>
      <button type="button" class="btn btn-danger" id="delete-location-button">Delete Location</button>
    </div>
  `;
}

function attachTableActions() {
  document.querySelector("#update-vendor-button")?.addEventListener("click", renderVendorForm);
  document.querySelector("#download-location-button")?.addEventListener("click", downloadLocation);
  document.querySelector("#delete-location-button")?.addEventListener("click", deleteLocation);
}

function renderForm(printerId = "") {
  currentView = "form";
  const printer = printers.find((item) => item.id === printerId) || {};
  const isEditing = Boolean(printerId);

  tableContainer.innerHTML = `
    <form id="printer-form">
      ${renderSiteLocationSelect(activeLocationId)}
      ${fields
        .map(
          (field) => `
            <div class="form-group">
              <label for="${field.key}">${field.label}</label>
              <input
                type="text"
                class="form-control"
                id="${field.key}"
                name="${field.key}"
                value="${escapeHtml(printer[field.key])}"
                placeholder="${field.placeholder}"
              >
            </div>
            
          `,
        )
        .join("")}
      <input type="hidden" id="tonerStatus" name="tonerStatus" value="${escapeHtml(printer.tonerStatus)}">
      <input type="hidden" id="tonerSupplies" name="tonerSupplies" value="${escapeHtml(JSON.stringify(printer.tonerSupplies || []))}">
      <input type="hidden" id="tonerCheckedAt" name="tonerCheckedAt" value="${escapeHtml(printer.tonerCheckedAt)}">
      <input type="hidden" id="vncAvailable" name="vncAvailable" value="${escapeHtml(Boolean(printer.vncAvailable))}">
      <input type="hidden" id="vncCheckedAt" name="vncCheckedAt" value="${escapeHtml(printer.vncCheckedAt)}">
      <input type="hidden" id="statusCheckedAt" name="statusCheckedAt" value="${escapeHtml(printer.statusCheckedAt)}">
      <div class="detect-status" id="detect-printer-status"></div>
      <div class="button-con">
        <button type="button" class="btn btn-info" id="detect-printer-button">
          <i class="fa-solid fa-magnifying-glass"></i> Detect
        </button>
        <button type="submit" class="btn btn-success">Submit</button>
        <button type="button" class="btn btn-primary" id="back-button">Back</button>
        ${
          isEditing
            ? '<button type="button" class="btn btn-danger" id="delete-button">Delete</button>'
            : ""
        }
      </div>
    </form>
  `;

  document.querySelector("#printer-form").addEventListener("submit", (event) => {
    event.preventDefault();
    savePrinter(printerId);
  });

  document.querySelector("#detect-printer-button").addEventListener("click", detectPrinterFromForm);
  document.querySelector("#back-button").addEventListener("click", renderTable);

  if (isEditing) {
    document.querySelector("#delete-button").addEventListener("click", () => deletePrinter(printerId));
  }
}

async function detectPrinterFromForm() {
  const form = document.querySelector("#printer-form");
  const detectButton = document.querySelector("#detect-printer-button");
  const statusElement = document.querySelector("#detect-printer-status");
  const ip = form.elements.ip.value.trim();

  if (!ip) {
    statusElement.textContent = "Enter an IP address first.";
    return;
  }

  detectButton.disabled = true;
  statusElement.textContent = "Detecting printer...";

  try {
    const result = await apiRequest("/api/printers/detect", {
      method: "POST",
      body: JSON.stringify({ ip }),
    });
    const fields = result.fields || {};
    const updatedFields = [
      setInputValue(form, "name", fields.name, { onlyIfEmpty: true }) && "name",
      setInputValue(form, "model", fields.model) && "model",
      setInputValue(form, "serialNo", fields.serialNo) && "serial number",
      setInputValue(form, "manufacturer", fields.manufacturer) && "manufacturer",
      setInputValue(form, "status", fields.status) && "status",
      setInputValue(form, "tonerStatus", fields.tonerStatus) && "toner",
      setInputValue(form, "tonerSupplies", fields.tonerSupplies) && "toner supplies",
      setInputValue(form, "tonerCheckedAt", fields.tonerCheckedAt) && "toner checked time",
      setInputValue(form, "vncAvailable", fields.vncAvailable) && "VNC",
      setInputValue(form, "vncCheckedAt", fields.vncCheckedAt) && "VNC checked time",
      setInputValue(form, "statusCheckedAt", fields.statusCheckedAt) && "status checked time",
    ].filter(Boolean);

    if (!result.online) {
      statusElement.textContent = "Printer did not respond to ping.";
      return;
    }

    statusElement.textContent = updatedFields.length
      ? `Detected ${updatedFields.join(", ")}.`
      : "Printer is online, but no extra fields were detected.";
  } catch (error) {
    console.error(error);
    statusElement.textContent = "Unable to detect printer details.";
  } finally {
    detectButton.disabled = false;
  }
}

function ensureVncModal() {
  let modal = document.querySelector("#vnc-modal");

  if (modal) {
    return modal;
  }

  modal = document.createElement("div");
  modal.id = "vnc-modal";
  modal.className = "vnc-modal";
  modal.innerHTML = `
    <div class="vnc-modal-panel" role="dialog" aria-modal="true" aria-labelledby="vnc-modal-title">
      <div class="vnc-toolbar">
        <div>
          <h2 id="vnc-modal-title">VNC</h2>
          <span id="vnc-status" class="vnc-status">Disconnected</span>
        </div>
        <div class="vnc-toolbar-actions">
          <button type="button" class="btn btn-outline-light" id="vnc-fullscreen-button" title="Fullscreen">
            <i class="fa-solid fa-expand"></i>
          </button>
          <button type="button" class="btn btn-danger" id="vnc-close-button" title="Close">
            <i class="fa-solid fa-xmark"></i>
          </button>
        </div>
      </div>
      <div class="vnc-password-panel" id="vnc-password-panel" hidden>
        <form id="vnc-password-form" class="vnc-password-form">
          <input type="text" class="form-control" id="vnc-username-input" autocomplete="username" placeholder="VNC username" hidden>
          <input type="password" class="form-control" id="vnc-password-input" autocomplete="current-password" placeholder="VNC password">
          <button type="submit" class="btn btn-primary">Connect</button>
        </form>
      </div>
      <div id="vnc-screen" class="vnc-screen"></div>
    </div>
  `;
  document.body.appendChild(modal);

  modal.querySelector("#vnc-close-button").addEventListener("click", closeVncModal);
  modal.addEventListener("click", (event) => {
    if (event.target === modal) {
      closeVncModal();
    }
  });
  modal.querySelector("#vnc-fullscreen-button").addEventListener("click", () => {
    modal.querySelector(".vnc-modal-panel").requestFullscreen?.();
  });
  modal.querySelector("#vnc-password-form").addEventListener("submit", (event) => {
    event.preventDefault();

    const passwordInput = modal.querySelector("#vnc-password-input");
    const usernameInput = modal.querySelector("#vnc-username-input");
    const passwordPanel = modal.querySelector("#vnc-password-panel");
    const credentials = { password: passwordInput.value };

    if (!usernameInput.hidden) {
      credentials.username = usernameInput.value;
    }

    rfbClient?.sendCredentials(credentials);
    passwordInput.value = "";
    passwordPanel.hidden = true;
    setVncStatus("Authenticating...");
  });

  return modal;
}

function setVncStatus(message) {
  const status = document.querySelector("#vnc-status");

  if (status) {
    status.textContent = message;
  }
}

function closeVncModal() {
  if (vncFrameKickTimer) {
    window.clearInterval(vncFrameKickTimer);
    vncFrameKickTimer = null;
  }

  if (rfbClient) {
    rfbClient.disconnect();
    rfbClient = null;
  }

  const modal = document.querySelector("#vnc-modal");

  if (modal) {
    modal.classList.remove("open");
    modal.querySelector("#vnc-screen").replaceChildren();
    modal.querySelector("#vnc-password-panel").hidden = true;
    modal.querySelector("#vnc-username-input").value = "";
    modal.querySelector("#vnc-username-input").hidden = true;
    modal.querySelector("#vnc-password-input").value = "";
    setVncStatus("Disconnected");
  }
}

function loadNoVnc() {
  if (!noVncModulePromise) {
    noVncModulePromise = import("/vendor/novnc-source/core/rfb.js?v=frame-kick-20260428");
  }

  return noVncModulePromise;
}

async function openVnc(ip, printerName, button) {
  button.disabled = true;
  const modal = ensureVncModal();
  const screen = modal.querySelector("#vnc-screen");
  const title = modal.querySelector("#vnc-modal-title");
  const passwordPanel = modal.querySelector("#vnc-password-panel");
  const usernameInput = modal.querySelector("#vnc-username-input");
  const passwordInput = modal.querySelector("#vnc-password-input");

  try {
    if (rfbClient) {
      rfbClient.disconnect();
      rfbClient = null;
    }

    screen.replaceChildren();
    passwordPanel.hidden = true;
    usernameInput.value = "";
    usernameInput.hidden = true;
    passwordInput.value = "";
    lastVncFailureReason = "";
    vncFramebufferUpdates = 0;
    vncConnectedAt = 0;
    if (vncFrameKickTimer) {
      window.clearInterval(vncFrameKickTimer);
      vncFrameKickTimer = null;
    }
    title.textContent = `${printerName || "Printer"} VNC`;
    modal.classList.add("open");
    setVncStatus("Loading browser VNC...");

    const { default: RFB } = await loadNoVnc();
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const vncUrl = `${protocol}//${window.location.host}/api/vnc?host=${encodeURIComponent(ip)}&port=5900`;

    setVncStatus(`Connecting to ${ip}...`);

    rfbClient = new RFB(screen, vncUrl);
    rfbClient.scaleViewport = true;
    rfbClient.resizeSession = false;
    rfbClient.clipViewport = false;
    rfbClient.showDotCursor = true;

    rfbClient.addEventListener("connect", () => {
      vncConnectedAt = Date.now();
      setVncStatus(`Connected to ${ip}; waiting for screen data...`);

      rfbClient.requestFrameUpdate?.(false);
      vncFrameKickTimer = window.setInterval(() => {
        if (!rfbClient || vncFramebufferUpdates > 0 || Date.now() - vncConnectedAt > 12000) {
          window.clearInterval(vncFrameKickTimer);
          vncFrameKickTimer = null;
          return;
        }

        rfbClient.requestFrameUpdate?.(false);
      }, 1000);

      window.setTimeout(() => {
        if (rfbClient && vncConnectedAt && vncFramebufferUpdates === 0) {
          const canvas = screen.querySelector("canvas");
          const canvasSize = canvas ? `${canvas.width}x${canvas.height}` : "no canvas";

          setVncStatus(`Connected, but no screen updates received yet (${canvasSize})`);
        }
      }, 3500);
    });
    rfbClient.addEventListener("disconnect", (event) => {
      if (vncFrameKickTimer) {
        window.clearInterval(vncFrameKickTimer);
        vncFrameKickTimer = null;
      }

      const reason = lastVncFailureReason || "Connection failed";

      setVncStatus(event.detail.clean ? "Disconnected" : reason);
    });
    rfbClient.addEventListener("securityfailure", (event) => {
      lastVncFailureReason = event.detail.reason || "VNC authentication failed. Check the VNC password and auth settings.";
      setVncStatus(lastVncFailureReason);
    });
    rfbClient.addEventListener("credentialsrequired", (event) => {
      const requiredTypes = event.detail?.types || ["password"];
      const needsUsername = requiredTypes.includes("username");

      usernameInput.hidden = !needsUsername;
      setVncStatus(needsUsername ? "Username and password required" : "Password required");
      passwordPanel.hidden = false;
      (needsUsername ? usernameInput : passwordInput).focus();
    });
    rfbClient.addEventListener("desktopname", (event) => {
      const name = event.detail?.name || "remote screen";

      setVncStatus(`Connected to ${ip}: ${name}`);
    });
    rfbClient.addEventListener("framebufferupdate", (event) => {
      vncFramebufferUpdates += 1;
      if (vncFrameKickTimer) {
        window.clearInterval(vncFrameKickTimer);
        vncFrameKickTimer = null;
      }

      const canvas = screen.querySelector("canvas");
      const canvasSize = canvas ? `${canvas.width}x${canvas.height}` : "no canvas";
      const remoteSize = event.detail?.width && event.detail?.height
        ? `${event.detail.width}x${event.detail.height}`
        : "unknown size";

      setVncStatus(`Connected: ${remoteSize}, updates ${vncFramebufferUpdates}, canvas ${canvasSize}`);
    });
  } catch (error) {
    console.error(error);
    const message = error?.message || "Unknown error";

    setVncStatus(`Unable to load browser VNC: ${message}`);
    window.alert(`Unable to open browser VNC: ${message}`);
  } finally {
    button.disabled = false;
  }
}

function renderLocationForm() {
  currentView = "form";
  vendorTitle.textContent = "Add Location";
  locationContainer.querySelectorAll(".location-row").forEach((row) => row.classList.remove("active"));
  addLocationButton.parentElement.classList.add("active");
  tableContainer.innerHTML = `
    <form id="location-form" class="compact-form">
      <div class="form-group">
        <label for="locationName">Location Name</label>
        <input
          type="text"
          class="form-control"
          id="locationName"
          name="name"
          placeholder="Enter location name"
          required
        >
      </div>
      <div class="form-group">
        <label for="vendorName">Vendor Name</label>
        <input
          type="text"
          class="form-control"
          id="vendorName"
          name="vendorName"
          value="Cannon"
          placeholder="Enter vendor name"
        >
      </div>
      <div class="form-group">
        <label for="vendorPhone">Vendor Phone</label>
        <input
          type="text"
          class="form-control"
          id="vendorPhone"
          name="vendorPhone"
          value="13 13 83"
          placeholder="Enter vendor phone"
        >
      </div>
      <div class="button-con">
        <button type="submit" class="btn btn-success">Submit</button>
        <button type="button" class="btn btn-primary" id="back-button">Back</button>
      </div>
    </form>
  `;

  document.querySelector("#location-form").addEventListener("submit", (event) => {
    event.preventDefault();
    saveLocation();
  });

  document.querySelector("#back-button").addEventListener("click", () => loadPrinters(activeLocationId));
  document.querySelector("#locationName").focus();
}

function renderVendorForm() {
  currentView = "form";
  const location = activeLocation();

  if (!location) {
    return;
  }

  vendorTitle.textContent = `Update Vendor: ${location.name}`;
  tableContainer.innerHTML = `
    <form id="vendor-form" class="compact-form">
      <div class="form-group">
        <label for="vendorName">Vendor Name</label>
        <input
          type="text"
          class="form-control"
          id="vendorName"
          name="vendorName"
          value="${escapeHtml(location.vendor?.name || "")}"
          placeholder="Enter vendor name"
          required
        >
      </div>
      <div class="form-group">
        <label for="vendorPhone">Vendor Phone</label>
        <input
          type="text"
          class="form-control"
          id="vendorPhone"
          name="vendorPhone"
          value="${escapeHtml(location.vendor?.phone || "")}"
          placeholder="Enter vendor phone"
          required
        >
      </div>
      <div class="button-con">
        <button type="submit" class="btn btn-success">Submit</button>
        <button type="button" class="btn btn-primary" id="back-button">Back</button>
      </div>
    </form>
  `;

  document.querySelector("#vendor-form").addEventListener("submit", (event) => {
    event.preventDefault();
    saveVendor();
  });

  document.querySelector("#back-button").addEventListener("click", () => loadPrinters(activeLocationId));
  document.querySelector("#vendorName").focus();
}

function renderDriverForm() {
  currentView = "form";
  const location = activeLocation();
  const models = availablePrinterModels();

  vendorTitle.textContent = location
    ? `Add Driver: ${location.name}`
    : "Add Driver";

  tableContainer.innerHTML = `
    <form id="driver-form" class="compact-form">
      <input type="hidden" name="siteLocationId" value="${escapeHtml(activeLocationId)}">
      ${renderDriverModelSelect()}
      <div class="form-group">
        <label for="driverVersion">Driver Version</label>
        <input
          type="text"
          class="form-control"
          id="driverVersion"
          name="version"
          placeholder="Optional version number"
        >
      </div>
      <div class="form-group">
        <label for="driverNotes">Notes</label>
        <textarea
          class="form-control"
          id="driverNotes"
          name="notes"
          rows="4"
          placeholder="Optional notes about this driver"
        ></textarea>
      </div>
      <div class="form-group">
        <label for="driverFile">Driver File</label>
        <input
          type="file"
          class="form-control"
          id="driverFile"
          name="driverFile"
          ${models.length ? "required" : "disabled"}
        >
      </div>
      <div class="detect-status" id="driver-form-status">
        ${models.length ? "" : "Add a printer with a model first so a driver can be linked to it."}
      </div>
      <div class="button-con">
        <button type="submit" class="btn btn-success" ${models.length ? "" : "disabled"}>Upload Driver</button>
        <button type="button" class="btn btn-primary" id="back-button">Back</button>
      </div>
    </form>
  `;

  document.querySelector("#driver-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    await saveDriver();
  });
  document.querySelector("#back-button").addEventListener("click", () => loadPrinters(activeLocationId));

  if (models.length) {
    document.querySelector("#driverModel").focus();
  }
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();

    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("Unable to read file."));
    reader.readAsDataURL(file);
  });
}

async function loadLocations() {
  locations = await apiRequest("/api/locations");
  activeLocationId = findLocationFromPath()?.id || locations[0]?.id || "";
  renderLocations();

  if (activeLocationId) {
    await loadPrinters(activeLocationId, { replacePath: true });
  }
}

async function refreshLocations() {
  locations = await apiRequest("/api/locations");
  renderLocations();
}

async function loadPrinters(locationId, options = {}) {
  activeLocationId = locationId;
  setLocationPath(locationId, Boolean(options.replacePath));
  renderLocations();
  renderVendor();

  if (!options.silent) {
    tableContainer.innerHTML = "<h2>Loading printers...</h2>";
  }

  const data = await apiRequest(`/api/locations/${locationId}/printers`);
  printers = data.printers;
  renderTable();
}

async function saveLocation() {
  const form = document.querySelector("#location-form");
  const formData = new FormData(form);
  const location = Object.fromEntries(formData.entries());
  const savedLocation = await apiRequest("/api/locations", {
    method: "POST",
    body: JSON.stringify(location),
  });

  await refreshLocations();
  await loadPrinters(savedLocation.id);
}

async function saveVendor() {
  const form = document.querySelector("#vendor-form");
  const formData = new FormData(form);
  const vendor = Object.fromEntries(formData.entries());
  const updatedLocation = await apiRequest(`/api/locations/${activeLocationId}/vendor`, {
    method: "PUT",
    body: JSON.stringify(vendor),
  });

  locations = locations.map((location) => (
    location.id === updatedLocation.id ? updatedLocation : location
  ));
  renderLocations();
  await loadPrinters(updatedLocation.id);
}

async function savePrinter(printerId) {
  const form = document.querySelector("#printer-form");
  const formData = new FormData(form);
  const printer = Object.fromEntries(formData.entries());
  const selectedLocationId = printer.siteLocationId || activeLocationId;

  delete printer.siteLocationId;

  if (printerId && selectedLocationId !== activeLocationId) {
    printer.id = printerId;
  }

  const url = printerId && selectedLocationId === activeLocationId
    ? `/api/locations/${activeLocationId}/printers/${printerId}`
    : `/api/locations/${selectedLocationId}/printers`;

  await apiRequest(url, {
    method: printerId && selectedLocationId === activeLocationId ? "PUT" : "POST",
    body: JSON.stringify(printer),
  });

  if (printerId && selectedLocationId !== activeLocationId) {
    await apiRequest(`/api/locations/${activeLocationId}/printers/${printerId}`, {
      method: "DELETE",
    });
  }

  await loadPrinters(selectedLocationId);
}

async function saveDriver() {
  const form = document.querySelector("#driver-form");
  const statusElement = document.querySelector("#driver-form-status");
  const submitButton = form.querySelector('button[type="submit"]');
  const fileInput = form.elements.driverFile;
  const file = fileInput.files?.[0];

  if (!file) {
    statusElement.textContent = "Choose a driver file first.";
    return;
  }

  statusElement.textContent = "Uploading driver...";
  submitButton.disabled = true;

  try {
    const dataUrl = await readFileAsDataUrl(file);
    const payload = {
      siteLocationId: form.elements.siteLocationId.value,
      model: form.elements.model.value.trim(),
      version: form.elements.version.value.trim(),
      notes: form.elements.notes.value.trim(),
      fileName: file.name,
      contentType: file.type || "application/octet-stream",
      fileData: dataUrl,
    };

    const result = await apiRequest("/api/drivers", {
      method: "POST",
      body: JSON.stringify(payload),
    });

    statusElement.textContent = `Uploaded ${result.fileName} for ${result.model}.`;
    window.alert(`Driver uploaded for ${result.model}.`);
    await loadPrinters(payload.siteLocationId || activeLocationId);
  } catch (error) {
    console.error(error);
    statusElement.textContent = "Unable to upload the driver.";
  } finally {
    submitButton.disabled = false;
  }
}

async function deletePrinter(printerId) {
  const shouldDelete = window.confirm("Delete this printer?");

  if (!shouldDelete) {
    return;
  }

  await apiRequest(`/api/locations/${activeLocationId}/printers/${printerId}`, {
    method: "DELETE",
  });

  await loadPrinters(activeLocationId);
}

function downloadLocation() {
  if (!activeLocationId) {
    return;
  }

  window.location.href = `/api/locations/${encodeURIComponent(activeLocationId)}/download`;
}

async function deleteLocation() {
  try {
    const location = activeLocation();

    if (!location) {
      return;
    }

    const shouldDelete = window.confirm(`Delete ${location.name} and all printers in it?`);

    if (!shouldDelete) {
      return;
    }

    const pin = window.prompt("Enter PIN to delete this location:");

    if (pin === null) {
      return;
    }

    await apiRequest(`/api/locations/${activeLocationId}`, {
      method: "DELETE",
      body: JSON.stringify({ pin }),
    });

    locations = locations.filter((item) => item.id !== activeLocationId);
    activeLocationId = locations[0]?.id || "";
    renderLocations();

    if (activeLocationId) {
      await loadPrinters(activeLocationId);
      return;
    }

    vendorTitle.textContent = "Vendor: None";
    printers = [];
    renderTable();
  } catch (error) {
    console.error(error);
    window.alert("Unable to delete location. Check the PIN and try again.");
    return;
  }
}

addPrinterButton.addEventListener("click", () => renderForm());
addDriverButton.addEventListener("click", renderDriverForm);
addLocationButton.addEventListener("click", renderLocationForm);
mobileLocationButton.addEventListener("click", toggleMobileLocationMenu);
document.addEventListener("click", (event) => {
  if (
    !mobileLocationMenu.hidden
    && !mobileLocationMenu.contains(event.target)
    && !mobileLocationButton.contains(event.target)
  ) {
    closeMobileLocationMenu();
  }
});
darkModeButton.addEventListener("click", () => {
  applyDarkMode(!document.body.classList.contains("dark-mode"));
});

window.addEventListener("popstate", () => {
  const location = findLocationFromPath();

  if (location) {
    loadPrinters(location.id, { replacePath: true }).catch(console.error);
  }
});

applyDarkMode(localStorage.getItem("printerManagerDarkMode") === "true");

setInterval(() => {
  if (activeLocationId && currentView === "table") {
    loadPrinters(activeLocationId, { silent: true }).catch(console.error);
  }
}, 60 * 1000);

loadLocations().catch((error) => {
  console.error(error);
  tableContainer.innerHTML = "<h2>Unable to load printer data.</h2>";
});

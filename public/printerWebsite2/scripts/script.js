const locationContainer = document.querySelector("#location-row-con");
const vendorTitle = document.querySelector("#vendor-title");
const addPrinterButton = document.querySelector("#add-printer-button");
const addLocationButton = document.querySelector("#add-location-button");
const darkModeButton = document.querySelector("#dark-mode-button");
const tableContainer = document.querySelector("#table-con");

let locations = [];
let activeLocationId = "";
let printers = [];
let currentView = "table";

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

function statusCheckedTitle(printer) {
  if (!printer.statusCheckedAt) {
    return "";
  }

  const checkedAt = new Date(printer.statusCheckedAt).toLocaleString();

  return ` title="Last checked ${escapeHtml(checkedAt)}"`;
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
  addLocationButton.parentElement.classList.remove("active");

  locationContainer.querySelectorAll(".location-row").forEach((button) => {
    button.addEventListener("click", () => loadPrinters(button.dataset.locationId));
  });
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
            <th scope="col">MachineNO</th>
            <th scope="col">SerialNO</th>
            <th scope="col">Location</th>
            <th scope="col">Department</th>
            <th scope="col">Manufacturer</th>
            <th scope="col">Status</th>
            <th scope="col"></th>
          </tr>
        </thead>
        <tbody>
          ${printers
            .map(
              (printer) => `
                <tr>
                  <th scope="row">${escapeHtml(printer.name)}</th>
                  <td><a href="http://${escapeHtml(printer.ip)}" target="_blank" rel="noreferrer">${escapeHtml(printer.ip)}</a></td>
                  <td>${escapeHtml(printer.model)}</td>
                  <td>${escapeHtml(printer.machineNo)}</td>
                  <td>${escapeHtml(printer.serialNo)}</td>
                  <td>${escapeHtml(printer.location)}</td>
                  <td>${escapeHtml(printer.department)}</td>
                  <td>${escapeHtml(printer.manufacturer)}</td>
                  <td${statusCheckedTitle(printer)}>${statusBadge(printer.status)}</td>
                  <td>
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
  attachTableActions();
}

function renderTableActions() {
  return `
    <div class="table-actions">
      <button type="button" class="btn btn-danger" id="delete-location-button">Delete Location</button>
    </div>
  `;
}

function attachTableActions() {
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
      <div class="button-con">
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

  document.querySelector("#back-button").addEventListener("click", renderTable);

  if (isEditing) {
    document.querySelector("#delete-button").addEventListener("click", () => deletePrinter(printerId));
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
addLocationButton.addEventListener("click", renderLocationForm);
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

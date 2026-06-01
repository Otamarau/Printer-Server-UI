# Printer Website 2 Server

An Express-based printer fleet management app. It serves a browser UI from `public/printerWebsite2`, stores site and printer records as local JSON files, checks printer health on the network, detects printer details through SNMP, links driver downloads to known models, and can proxy browser-based VNC sessions for supported printers.

## Features

- Manage multiple customer/site locations
- Add, edit, move, and delete printer records
- Store each location in a separate JSON file under `data/`
- Download a location's printer data as JSON
- Detect printer name, manufacturer, model, serial number, toner, and VNC availability from an IP address
- Refresh online/offline, toner, and VNC status on a schedule
- Upload printer drivers and link the newest driver to matching printer models 
- Proxy VNC over WebSocket for noVNC in the browser
- Protect location deletion with a configured PIN
- Create scheduled backups of top-level `data/*.json` files

## Tech Stack

- Node.js
- Express 5
- Plain HTML, CSS, and JavaScript frontend
- Local JSON file storage
- Built-in ping, SNMP, TCP, HTTP/HTTPS, and WebSocket handling in `server.js`
- Vendored noVNC client code in `public/printerWebsite2/vendor/novnc-source`

## Requirements

- Node.js 18 or newer
- npm
- Network access from the server machine to the printers
- SNMP enabled on printers for automatic model, serial, and toner detection
- VNC enabled on printers for browser VNC access
- HTTPS when using password-protected VNC from another machine or non-localhost URL

## Getting Started

Install dependencies:

```sh
npm install
```

Create a local config file:

```sh
cp config.example.json config.json
```

On first startup, the server will also copy `config.example.json` to `config.json` automatically if `config.json` does not exist.

Set a location deletion PIN in `config.json`:

```json
{
  "deleteLocationPin": "change-me",
  "driverUploadJsonLimit": "150mb"
}
```

Start the server:

```sh
npm start
```

Open:

```txt
http://localhost:3000
```

For development with Node watch mode:

```sh
npm run dev
```

## Project Structure

```txt
.
├── server.js                         # Express server, API, status checks, backups, VNC proxy
├── package.json                      # npm scripts and dependencies
├── config.example.json               # Example local config
├── config.json                       # Local config, ignored by Git
├── data/                             # Location JSON files and scheduled backups
├── drivers/                          # Uploaded driver files and driver index
└── public/printerWebsite2/           # Browser UI
    ├── index.html
    ├── scripts/script.js
    ├── styles/styles.css
    └── vendor/novnc-source/
```

## Configuration

The server reads `config.json` by default. Use `CONFIG_FILE` to point at a different config file. Environment variables override config values where supported.

| Name | Default | Description |
| --- | --- | --- |
| `CONFIG_FILE` | `./config.json` | Path to the local config file |
| `PORT` | `3000` | HTTP or HTTPS server port |
| `HTTPS_CERT_FILE` | `config.httpsCertFile` | TLS certificate file |
| `HTTPS_KEY_FILE` | `config.httpsKeyFile` | TLS private key file |
| `DELETE_LOCATION_PIN` | `config.deleteLocationPin` | PIN required to delete a location |
| `DRIVER_UPLOAD_JSON_LIMIT` | `config.driverUploadJsonLimit` or `150mb` | JSON body limit for driver uploads |
| `BACKUP_DIR` | `./data/backups` | Directory for backup snapshots |
| `BACKUP_INTERVAL_MS` | `86400000` | Scheduled backup interval |
| `BACKUP_RETENTION_COUNT` | `30` | Number of backup snapshots to keep |
| `PING_INTERVAL_MS` | `300000` | Background printer status refresh interval |
| `PING_TIMEOUT_MS` | `1000` | Ping timeout per printer |
| `PING_CONCURRENCY` | `10` | Number of printers checked in parallel |
| `SNMP_COMMUNITY` | `public` | SNMP community string |
| `SNMP_TIMEOUT_MS` | `1200` | SNMP request timeout |
| `SNMP_MAX_SUPPLIES` | `40` | Maximum supply rows to inspect during SNMP toner detection |
| `VNC_PORT` | `5900` | VNC port used for detection and proxy connections |
| `VNC_CONNECT_TIMEOUT_MS` | `5000` | Timeout when opening a VNC proxy connection |
| `VNC_SCAN_TIMEOUT_MS` | `1500` | Timeout when checking whether VNC is available |

Example HTTPS config:

```json
{
  "deleteLocationPin": "change-me",
  "driverUploadJsonLimit": "150mb",
  "httpsCertFile": "C:/path/to/cert.pem",
  "httpsKeyFile": "C:/path/to/key.pem"
}
```

PowerShell equivalent:

```powershell
$env:HTTPS_CERT_FILE = "C:\path\to\cert.pem"
$env:HTTPS_KEY_FILE = "C:\path\to\key.pem"
npm start
```

## Data Storage

Each location is stored as a JSON file in `data/`. A location file contains the location metadata, vendor details, and printer list:

```json
{
  "id": "example-site",
  "name": "Example Site",
  "vendor": {
    "name": "Cannon",
    "phone": "13 13 83"
  },
  "printers": []
}
```

The server creates `data/` and `drivers/` if they are missing. It loads every top-level `data/*.json` file on startup. Scheduled backups copy top-level `data/*.json` files into timestamped directories under `data/backups/`.

`config.json`, `data/`, and uploaded driver files can contain private operational data. Keep them out of public commits unless the contents are anonymized.

## Driver Uploads

Drivers are uploaded through the web UI as base64 data URLs. The server stores driver files under `drivers/<model>/` and records metadata in `drivers/index.json`.

Drivers can only be uploaded for printer models already present in the location data. When a printer is returned from the API, the newest matching driver for its model is included as a download link.

## VNC Support

The frontend uses noVNC from `public/printerWebsite2/vendor/novnc-source`. The server exposes `/api/vnc` as a WebSocket-to-TCP proxy and only allows connections to valid IP addresses on the configured `VNC_PORT`.

Modern browsers require a secure context for some noVNC features, especially password-protected sessions. `http://localhost:3000` is usually allowed for local testing. For access from another machine, serve the app with HTTPS.

Keep the vendored noVNC and pako license files when redistributing this project:

- `public/printerWebsite2/vendor/novnc-source/LICENSE.txt`
- `public/printerWebsite2/vendor/novnc-source/vendor/pako/LICENSE`

## API Overview

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/locations` | List locations |
| `POST` | `/api/locations` | Create a location |
| `DELETE` | `/api/locations/:locationId` | Delete a location with the configured PIN |
| `PUT` | `/api/locations/:locationId/vendor` | Update location vendor details |
| `GET` | `/api/locations/:locationId/download` | Download a location JSON file |
| `GET` | `/api/locations/:locationId/printers` | List printers for a location, including matching driver metadata |
| `POST` | `/api/locations/:locationId/printers` | Create a printer |
| `PUT` | `/api/locations/:locationId/printers/:printerId` | Update a printer |
| `DELETE` | `/api/locations/:locationId/printers/:printerId` | Delete a printer |
| `GET` | `/api/printer-models` | List known printer models from stored printer data |
| `POST` | `/api/printers/detect` | Detect printer details from an IP address |
| `POST` | `/api/printers/check-status` | Run a manual status refresh |
| `POST` | `/api/drivers` | Upload a driver for a known printer model |
| `GET` | `/api/drivers/:driverId/download` | Download an uploaded driver |
| `WS` | `/api/vnc?host=<ip>&port=5900` | Proxy a noVNC WebSocket session to a printer |

## Notes

- There is no database service to run. Local JSON files are the source of truth.
- There is no authentication layer beyond the location deletion PIN.
- SNMP detection depends on printer support and the configured community string.
- Ping behavior depends on the host OS and network firewall rules.
- The project is marked as `ISC` in `package.json`; add a root `LICENSE` file if this repository will be published.

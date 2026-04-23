# Printer Manager Server

A small Express server and browser UI for managing printer fleets across multiple locations. It stores printer/location data as local JSON files, checks basic printer availability, reads printer details and toner information over SNMP, and can open browser-based VNC sessions for supported devices through noVNC.

## Features

- Manage locations and printer records from a web UI
- Store each location as a JSON file in `data/`
- Back up JSON data files on a schedule
- Detect printer details from an IP address using ping and SNMP
- Track online/offline status and toner supply status
- Open printer VNC sessions in the browser when VNC is available
- Protect location deletion with a locally configured PIN

## Requirements

- Node.js 18 or newer
- npm
- Network access from the server to the printers you want to manage
- Printers with SNMP enabled for automatic model, serial, and toner detection
- VNC-enabled printers if you want browser VNC access

## Setup

Install dependencies:

```sh
npm install
```

Create a local config file:

```sh
cp config.example.json config.json
```

The server will also create `config.json` from `config.example.json` on first startup if it is missing. Edit `config.json` and set your deletion PIN:

```json
{
  "deleteLocationPin": "your-pin-here"
}
```

Start the server:

```sh
npm start
```

Open the app at:

```txt
http://localhost:3000
```

For development with Node's watch mode:

```sh
npm run dev
```

## Configuration

The server reads `config.json` by default. You can point it at another config file with `CONFIG_FILE`.

Environment variables override config values where supported.

| Name | Default | Description |
| --- | --- | --- |
| `CONFIG_FILE` | `./config.json` | Path to the local config file |
| `BACKUP_DIR` | `./data/backups` | Directory for scheduled JSON data backups |
| `BACKUP_INTERVAL_MS` | `86400000` | Interval for scheduled JSON data backups |
| `BACKUP_RETENTION_COUNT` | `30` | Number of backup snapshots to keep |
| `DELETE_LOCATION_PIN` | config value | PIN required to delete a location |
| `PORT` | `3000` | HTTP server port |
| `PING_INTERVAL_MS` | `300000` | Interval for background printer status checks |
| `PING_TIMEOUT_MS` | `1000` | Ping timeout per printer |
| `PING_CONCURRENCY` | `10` | Number of printers checked in parallel |
| `SNMP_COMMUNITY` | `public` | SNMP community string |
| `SNMP_TIMEOUT_MS` | `1200` | SNMP request timeout |
| `SNMP_MAX_SUPPLIES` | `40` | Maximum SNMP supply rows to inspect |
| `VNC_PORT` | `5900` | Default VNC port |
| `VNC_CONNECT_TIMEOUT_MS` | `5000` | VNC connection timeout |
| `VNC_SCAN_TIMEOUT_MS` | `1500` | VNC availability scan timeout |

`config.json` and `data/` are ignored by Git so private PINs and site-specific printer data are not published.

## Data

Location and printer records are stored as JSON files in `data/`. The server creates this directory on startup if it does not already exist. Each location file contains the location metadata, vendor details, and printer list.

The server automatically copies all top-level `data/*.json` files into timestamped folders under `data/backups/`. By default it backs up shortly after startup, then once every 24 hours, and keeps the most recent 30 snapshots. You can change this with `BACKUP_DIR`, `BACKUP_INTERVAL_MS`, and `BACKUP_RETENTION_COUNT`, or by setting `backupIntervalMs` and `backupRetentionCount` in `config.json`.

The `data/` directory is intentionally ignored. To publish a clean open-source repository, include only example or anonymized data if you choose to add sample files.

## noVNC

This project includes noVNC under `public/printerWebsite2/vendor/novnc-source` for browser VNC support. noVNC is mainly licensed under MPL-2.0, with bundled dependencies and assets covered by their own compatible licenses. Keep the noVNC license files with the vendored source when publishing or redistributing this project.

See:

- `public/printerWebsite2/vendor/novnc-source/LICENSE.txt`
- `public/printerWebsite2/vendor/novnc-source/vendor/pako/LICENSE`

## License

This project is currently marked as `ISC` in `package.json`. Add a root `LICENSE` file before publishing if you want GitHub and package tools to clearly identify the project license.

Third-party code keeps its original license terms, including noVNC and pako.

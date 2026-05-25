# NexStackSolutions

NexStackSolutions is a Windows desktop attendance portal for IT operations teams. The app is built with Electron, React, TypeScript, Express, and SQLite, and it syncs attendance data to Google Sheets with offline queueing and automatic retry.

## What it does

- Employee login with Employee ID only
- Admin dashboard for corrections, reports, and audit logs
- Offline-first attendance capture with eventual sync to Google Sheets
- PKT-based shift handling for the 10:00 PM to 6:00 AM schedule
- Tray-based startup, reminder popup, and watchdog relaunch behavior on Windows

## Requirements

- Windows 10 or later
- Node.js 24+
- Google service account with access to the target spreadsheet

## Environment variables

Create a `.env` file using the values in `.env.example`.

## Development

```bash
npm install
npm run dev
```

## Production build

```bash
npm run build
```

The Windows installer is written to `release/`.

## Data model

The SQLite schema lives in [database/schema.sql](database/schema.sql).

## Tests

```bash
npm test
```

## Google Sheets sync

See [docs/google-sheets-setup.md](docs/google-sheets-setup.md).

## Deployment

See [docs/deployment.md](docs/deployment.md).
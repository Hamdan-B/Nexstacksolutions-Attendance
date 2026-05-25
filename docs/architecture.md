# Architecture

## Process layout

- Electron main process hosts the tray, watchdog, auto-start registration, and the local Express API.
- The preload script exposes a narrow API surface to the React renderer.
- SQLite stores sessions, employee cache, attendance cache, audit logs, and sync queue entries.
- Google Sheets stores the authoritative remote attendance data.

## Data flow

1. Employee enters an Employee ID.
2. The app resolves the employee from the local cache or Google Sheets bootstrap.
3. Check-ins are written to SQLite immediately.
4. The sync engine retries unsynced items every 60 seconds.
5. Once the network is available, queued attendance is written to Google Sheets and marked synced locally.

## Security model

- JWTs protect the local session state.
- Local secrets are encrypted with AES-256-GCM.
- Device fingerprints are computed from machine metadata and network identifiers.
- Window closure hides the app instead of terminating it.
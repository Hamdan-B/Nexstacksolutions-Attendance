# Deployment Guide

## 1. Prepare the office machine

- Install Node.js 24 or later on the build machine.
- Create a Google service account and share the spreadsheet with its email.
- Confirm the office PCs are running Windows and have access to the internet when sync is required.

## 2. Configure environment

Set the following environment variables before launching the app:

- `GOOGLE_SERVICE_ACCOUNT_JSON`
- `GOOGLE_SERVICE_ACCOUNT_FILE`
- `GOOGLE_SHEETS_SPREADSHEET_ID`
- `NEXSTACK_SECRET`

For a public GitHub repository, keep the service account JSON out of source control and set `GOOGLE_SERVICE_ACCOUNT_FILE` on the build machine to a local file path that is not committed.

## 3. Install and run

```bash
npm install
npm run build
```

The packaged installer is created in `release/`.

## 4. Windows startup behavior

The app registers itself in the current user Run registry key and keeps a tray instance active. Closing the window hides it rather than terminating the process.

## 5. Update strategy

The app includes electron-updater support. Point the `publish` target to your update host before releasing production builds.

Recommended GitHub flow:

1. Create a public repository for the project source, or keep source private and use a separate public release repository.
2. Add a GitHub release `publish` target in `package.json`.
3. Set `GH_TOKEN` on the build machine only.
4. Run `npm run build` to generate the installer and release metadata.
5. Upload the release artifacts to GitHub Releases.
6. Installed PCs will check for updates automatically on startup.
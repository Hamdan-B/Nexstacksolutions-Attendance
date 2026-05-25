# Google Sheets Setup

Create a spreadsheet with these sheets:

## Employees

Columns:

- `EmployeeID`
- `EmployeeName`
- `Role`
- `Active`
- `AssignedDeviceID`

Example rows:

- `EMP001 | Hamdan | Employee | TRUE | DEVICE123`
- `ADMIN001 | Admin | Admin | TRUE | ADMINPC01`

## Attendance

Row 1 should contain the date column and employee names.

Example:

- `Date | Hamdan | Ali | Ahmed`

Each attendance row stores one shift date.

Examples:

- `2026-05-20 | 10:05 PM | 10:18 PM (Late) | Absent`

## AuditLogs

Columns:

- `Timestamp`
- `AdminID`
- `EmployeeID`
- `Action`
- `OldValue`
- `NewValue`
- `Reason`

## Service account

- Create a Google Cloud project.
- Enable the Google Sheets API.
- Create a service account and download the JSON key.
- Share the spreadsheet with the service account email.
- Set `GOOGLE_SERVICE_ACCOUNT_JSON` to the JSON string or inject it from a secure secret store.

## Validation

The app validates Google responses and keeps an offline queue until synchronization succeeds.
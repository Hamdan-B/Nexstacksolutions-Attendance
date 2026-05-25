#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');

async function main() {
  try {
    const keyPath = path.join(__dirname, '..', 'attendance-497219-5639b795c42f.json');
    if (!fs.existsSync(keyPath)) {
      console.error('Service account JSON not found at', keyPath);
      process.exit(2);
    }
    const serviceAccount = JSON.parse(fs.readFileSync(keyPath, 'utf8'));
    const sheetId = '1kz0NfIz3909f-7Wp0EWoZZnocqPg3KvbfetlOfSPI8w';
    const auth = new google.auth.JWT(serviceAccount.client_email, undefined, serviceAccount.private_key, ['https://www.googleapis.com/auth/spreadsheets']);
    const sheets = google.sheets({ version: 'v4', auth });

    console.log('Fetching spreadsheet metadata...');
    const meta = await sheets.spreadsheets.get({ spreadsheetId: sheetId });
    const existing = (meta.data.sheets || []).map((s) => s.properties && s.properties.title).filter(Boolean);
    console.log('Existing sheets:', existing.join(', '));

    const required = ['Employees', 'Attendance', 'AuditLogs'];
    const requests = [];
    for (const name of required) {
      if (!existing.includes(name)) requests.push({ addSheet: { properties: { title: name } } });
    }
    if (requests.length > 0) {
      console.log('Adding missing sheets:', requests.map((r) => r.addSheet.properties.title).join(', '));
      await sheets.spreadsheets.batchUpdate({ spreadsheetId: sheetId, requestBody: { requests } });
    } else {
      console.log('All required sheets present');
    }

    // Employees header
    const empHeader = ['EmployeeID', 'EmployeeName', 'Role', 'Active', 'AssignedDeviceID'];
    const empHeaderResp = await sheets.spreadsheets.values.get({ spreadsheetId: sheetId, range: 'Employees!A1:E1' }).catch(() => ({ data: { values: [] } }));
    const empHeaders = (empHeaderResp.data.values && empHeaderResp.data.values[0]) || [];
    if (empHeaders.length === 0 || empHeaders.join('|') !== empHeader.join('|')) {
      console.log('Setting Employees header...');
      await sheets.spreadsheets.values.update({ spreadsheetId: sheetId, range: 'Employees!A1:E1', valueInputOption: 'RAW', requestBody: { values: [empHeader] } });
    } else {
      console.log('Employees header OK');
    }
    const empDataResp = await sheets.spreadsheets.values.get({ spreadsheetId: sheetId, range: 'Employees!A2:E2' }).catch(() => ({ data: { values: [] } }));
    const empData = empDataResp.data.values || [];
    if (empData.length === 0) {
      console.log('Adding example Employees row...');
      const example = ['EXAMPLE001', 'Example Employee', 'Employee', 'TRUE', 'EXAMPLE-DEVICE-01'];
      await sheets.spreadsheets.values.update({ spreadsheetId: sheetId, range: 'Employees!A2:E2', valueInputOption: 'RAW', requestBody: { values: [example] } });
    } else {
      console.log('Employees has data; skipping example row');
    }

    // Attendance header
    const attHeaderResp = await sheets.spreadsheets.values.get({ spreadsheetId: sheetId, range: 'Attendance!A1:ZZ1' }).catch(() => ({ data: { values: [] } }));
    const attHeaders = (attHeaderResp.data.values && attHeaderResp.data.values[0]) || [];
    if (attHeaders.length === 0 || String(attHeaders[0]) !== 'Date') {
      console.log('Setting Attendance header (A1 = Date)');
      await sheets.spreadsheets.values.update({ spreadsheetId: sheetId, range: 'Attendance!A1:ZZ1', valueInputOption: 'RAW', requestBody: { values: [['Date']] } });
    } else {
      console.log('Attendance header OK');
    }

    // AuditLogs header
    const auditHeader = ['Timestamp', 'AdminID', 'EmployeeID', 'Action', 'OldValue', 'NewValue', 'Reason'];
    const auditHeaderResp = await sheets.spreadsheets.values.get({ spreadsheetId: sheetId, range: 'AuditLogs!A1:G1' }).catch(() => ({ data: { values: [] } }));
    const auditHeaders = (auditHeaderResp.data.values && auditHeaderResp.data.values[0]) || [];
    if (auditHeaders.length === 0 || auditHeaders.join('|') !== auditHeader.join('|')) {
      console.log('Setting AuditLogs header...');
      await sheets.spreadsheets.values.update({ spreadsheetId: sheetId, range: 'AuditLogs!A1:G1', valueInputOption: 'RAW', requestBody: { values: [auditHeader] } });
    } else {
      console.log('AuditLogs header OK');
    }

    console.log('One-time sheet initialization complete.');
  } catch (err) {
    console.error('Initialization failed:', err && (err.message || err));
    process.exitCode = 1;
  }
}

main();

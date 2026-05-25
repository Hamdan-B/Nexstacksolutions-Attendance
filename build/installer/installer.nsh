; Custom NSIS include for electron-builder
; Runs the client prepare script after successful install to add UDP firewall rule.

Function .onInstSuccess
  ; Path to the unpacked script inside the installed app
  StrCpy $0 "$INSTDIR\resources\app.asar.unpacked\scripts\prepare-client.ps1"
  ; If the script exists, run it with PowerShell silently
  IfFileExists "$0" 0 +2
    ExecWait 'powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "$0"' $0

  ; Write auto-start registry entry for the current user
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "NexStackSolutions" '"$INSTDIR\NexStackSolutions.exe"'

  ; Launch the app immediately after install
  ExecShell "open" "$INSTDIR\NexStackSolutions.exe"
FunctionEnd

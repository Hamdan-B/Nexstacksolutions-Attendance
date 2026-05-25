Param(
    [string]$CentralIP = "",
    [int]$CentralPort = 0
)

# Determine elevation (firewall changes require admin)
$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
$isAdmin = $principal.IsInRole([Security.Principal.WindowsBuiltinRole]::Administrator)

if ($isAdmin) {
    Write-Host "Configuring client firewall for NexStack UDP discovery (41234)"

    # UDP discovery rule
    if (-not (Get-NetFirewallRule -DisplayName "NexStack UDP Discovery" -ErrorAction SilentlyContinue)) {
        New-NetFirewallRule -DisplayName "NexStack UDP Discovery" -Direction Inbound -Protocol UDP -LocalPort 41234 -Action Allow | Out-Null
        Write-Host "Added UDP rule: 41234"
    } else {
        Write-Host "UDP rule already exists"
    }
} else {
    Write-Warning "Not running as Administrator. Firewall rule setup skipped, but client setup will continue."
}

# If central IP/port provided, write a small override file the app can read (app will need restart)
if ($CentralIP -and $CentralPort -gt 0) {
    $cfgDir = Join-Path $env:APPDATA "nexstacksolutions"
    if (-not (Test-Path $cfgDir)) { New-Item -Path $cfgDir -ItemType Directory | Out-Null }
    $cfgPath = Join-Path $cfgDir "client_known_central.json"
    $obj = @{ centralHost = $CentralIP; centralPort = $CentralPort }
    $obj | ConvertTo-Json | Out-File -FilePath $cfgPath -Encoding UTF8 -Force
    Write-Host "Wrote central override to $cfgPath. Restart the NexStack app on this machine to apply."

    # Quick connectivity test
    Write-Host "Testing connectivity to $CentralIP:$CentralPort"
    Test-NetConnection -ComputerName $CentralIP -Port $CentralPort | Format-List
} else {
    Write-Host "No central IP/port provided. To set one, re-run with -CentralIP x.x.x.x -CentralPort <port>"
}

Write-Host "Done."

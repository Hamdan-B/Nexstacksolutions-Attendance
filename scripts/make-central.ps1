Param(
    [string]$ExePath = "",
    [string]$ActivationCode = "NEXSTACK-CENTRAL-742918"
)

# Ensure running as Administrator
$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltinRole]::Administrator)) {
    Write-Error "This script must be run as Administrator. Right-click PowerShell and choose 'Run as administrator'."
    exit 1
}

$apiPortPath = Join-Path $env:APPDATA "nexstacksolutions\api.port"
if (-not (Test-Path $apiPortPath)) {
    Write-Error "Cannot find api.port at $apiPortPath. Start the NexStack app once and retry."
    exit 1
}

$port = (Get-Content $apiPortPath | Select-Object -First 1).Trim()
if (-not $port) {
    Write-Error "api.port is empty. Ensure the app started and wrote the port."
    exit 1
}

if (-not $ExePath) {
    $possibleExePaths = @(
        (Join-Path $env:LOCALAPPDATA "Programs\NexStackSolutions\NexStackSolutions.exe"),
        "C:\Program Files\NexStackSolutions\NexStackSolutions.exe",
        "C:\Program Files (x86)\NexStackSolutions\NexStackSolutions.exe"
    )
    $ExePath = $possibleExePaths | Where-Object { Test-Path $_ } | Select-Object -First 1
}

if (-not $ExePath) {
    Write-Warning "Could not find NexStackSolutions.exe automatically. Firewall program rule will be skipped unless you provide -ExePath."
}

Write-Host "Configuring firewall for NexStack: UDP 41234 and TCP $port"

# UDP discovery rule
if (-not (Get-NetFirewallRule -DisplayName "NexStack UDP Discovery" -ErrorAction SilentlyContinue)) {
    New-NetFirewallRule -DisplayName "NexStack UDP Discovery" -Direction Inbound -Protocol UDP -LocalPort 41234 -Action Allow | Out-Null
    Write-Host "Added UDP rule: 41234"
} else {
    Write-Host "UDP rule already exists"
}

# TCP API port rule
$tcpRuleName = "NexStack HTTP API (port $port)"
if (-not (Get-NetFirewallRule -DisplayName $tcpRuleName -ErrorAction SilentlyContinue)) {
    New-NetFirewallRule -DisplayName $tcpRuleName -Direction Inbound -Protocol TCP -LocalPort $port -Action Allow | Out-Null
    Write-Host "Added TCP rule for port $port"
} else {
    Write-Host "TCP port rule already exists"
}

# Optional: add program rule if exe path exists
if (Test-Path $ExePath) {
    $exeRule = "NexStack App"
    if (-not (Get-NetFirewallRule -DisplayName $exeRule -ErrorAction SilentlyContinue)) {
        New-NetFirewallRule -DisplayName $exeRule -Direction Inbound -Program $ExePath -Action Allow | Out-Null
        Write-Host "Added firewall rule for program: $ExePath"
    } else {
        Write-Host "Program firewall rule already exists"
    }
} else {
    Write-Host "Executable not found at $ExePath — skipping program rule."
}

# Try to claim central via local HTTP endpoint
$secretPath = Join-Path $env:APPDATA "nexstacksolutions\secret.key"
$headers = @{ }
if (Test-Path $secretPath) {
    $secret = (Get-Content $secretPath -Raw).Trim()
    if ($secret) { $headers['x-nexstack-secret'] = $secret }
}

$claimUri = "http://127.0.0.1:$port/admin/central"
$body = @{ code = $ActivationCode } | ConvertTo-Json

Write-Host "Attempting to claim central via $claimUri"
try {
    $resp = Invoke-RestMethod -Uri $claimUri -Method Post -Headers $headers -Body $body -ContentType 'application/json' -TimeoutSec 10
    Write-Host "Claim response:`n$($resp | ConvertTo-Json -Depth 4)"
} catch {
    Write-Warning "Claim attempt failed: $($_.Exception.Message)"
    Write-Host "If claiming fails, open the app UI on this machine and use the Central -> Make Central button with the code: $ActivationCode"
}

Write-Host "Done. Restart the NexStack app if necessary."

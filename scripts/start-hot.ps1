param(
  [string]$ExtensionIds,
  [string]$ChromeProfilePath,
  [switch]$PersistEnv,
  [switch]$KillPort,
  [switch]$AllowAnyExtension
)

function Ensure-Value {
  param(
    [string]$Value,
    [string]$Prompt
  )

  if ($Value -and $Value.Trim().Length -gt 0) {
    return $Value
  }

  $inputValue = Read-Host $Prompt
  if (-not $inputValue -or $inputValue.Trim().Length -eq 0) {
    throw "Missing required value: $Prompt"
  }
  return $inputValue
}

if ($AllowAnyExtension) {
  $ExtensionIds = ''
} else {
  $ExtensionIds = Ensure-Value -Value $ExtensionIds -Prompt "Enter SSPA_EXTENSION_IDS (comma-separated extension IDs)"
}
$ChromeProfilePath = Ensure-Value -Value $ChromeProfilePath -Prompt "Enter CHROME_PROFILE_PATH (Chrome User Data path)"

$env:SSPA_EXTENSION_IDS = $ExtensionIds
$env:CHROME_PROFILE_PATH = $ChromeProfilePath
$env:NODE_OPTIONS = "--openssl-legacy-provider"

if ($PersistEnv) {
  setx SSPA_EXTENSION_IDS $ExtensionIds /m | Out-Null
  setx CHROME_PROFILE_PATH $ChromeProfilePath /m | Out-Null
}

if ($AllowAnyExtension) {
  Write-Host "SSPA_EXTENSION_IDS=<any>"
} else {
  Write-Host "SSPA_EXTENSION_IDS=$($env:SSPA_EXTENSION_IDS)"
}
Write-Host "CHROME_PROFILE_PATH=$($env:CHROME_PROFILE_PATH)"

$rootDir = Split-Path -Parent $PSScriptRoot

$portInUse = Get-NetTCPConnection -State Listen -LocalPort 19989 -ErrorAction SilentlyContinue
if ($portInUse) {
  $processId = $portInUse.OwningProcess | Select-Object -First 1
  if ($KillPort) {
    Stop-Process -Id $processId -Force
    Write-Host "Killed process on port 19989: PID $processId"
  } else {
    throw "Port 19989 already in use (PID $processId). Rerun with -KillPort or stop the relay process."
  }
}

Write-Host "Starting hot reload (extension + relay + MCP)..."

$escapedProfilePath = $ChromeProfilePath.Replace('"', '\"')

$commands = @(
  "pnpm --dir ext exec webpack --watch",
  "node ext/scripts/watch-build-chrome.js",
  "pnpm --dir ext exec web-ext run --source-dir dist-chrome --target chromium --chromium-profile ""$escapedProfilePath""",
  "pnpm --dir mcp exec tsx watch src/relay.ts",
  "pnpm --dir mcp exec tsx watch src/mcp.ts"
)

pnpm exec concurrently --kill-others-on-fail -s first --names "WPK,COPY,EXT,REL,MCP" -c "magenta,cyan,blue,green,yellow" $commands

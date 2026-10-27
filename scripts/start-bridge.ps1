$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $PSScriptRoot
$node = (Get-Command node -ErrorAction Stop).Source
$logDir = Join-Path $repo "logs"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$stdout = Join-Path $logDir "bridge.out.log"
$stderr = Join-Path $logDir "bridge.err.log"
$args = @(
  "--env-file-if-exists=.env",
  (Join-Path $repo "node_modules/tsx/dist/cli.mjs"),
  (Join-Path $repo "src/main.ts")
)
$existing = Get-NetTCPConnection -LocalPort ([int]($env:PTPP_MCP_BRIDGE_PORT ?? "19799")) -State Listen -ErrorAction SilentlyContinue
if ($existing) {
  Write-Host "PTPP MCP bridge already listens on port $($env:PTPP_MCP_BRIDGE_PORT ?? '19799')."
  exit 0
}
Start-Process -FilePath $node -ArgumentList $args -WorkingDirectory $repo -WindowStyle Hidden -RedirectStandardOutput $stdout -RedirectStandardError $stderr | Out-Null
Write-Host "PTPP MCP bridge started in the background. Logs: $stderr"

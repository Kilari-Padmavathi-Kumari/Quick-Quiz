$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

function Stop-PortListener {
  param(
    [Parameter(Mandatory = $true)]
    [int]$Port
  )

  $listener = Get-NetTCPConnection -LocalPort $Port -ErrorAction SilentlyContinue |
    Where-Object { $_.State -eq "Listen" } |
    Select-Object -First 1

  if ($listener -and $listener.OwningProcess -and $listener.OwningProcess -ne 0) {
    try {
      Stop-Process -Id $listener.OwningProcess -Force -ErrorAction Stop
    } catch {
      Write-Warning "Could not stop process on port ${Port}: $($_.Exception.Message)"
    }
  }
}

function Start-ServiceWindow {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Title,
    [Parameter(Mandatory = $true)]
    [string]$Command
  )

  Start-Process powershell -ArgumentList @(
    "-NoExit",
    "-Command",
    "`$Host.UI.RawUI.WindowTitle = '$Title'; cd '$root'; $Command"
  ) | Out-Null
}

Stop-PortListener -Port 3000
Stop-PortListener -Port 4000
Stop-PortListener -Port 4001
Stop-PortListener -Port 4002

Start-ServiceWindow -Title "Quiz Master API" -Command "pnpm dev:api"
Start-ServiceWindow -Title "Quiz Master Frontend" -Command "pnpm dev:frontend"
Start-ServiceWindow -Title "Quiz Master Game" -Command "pnpm dev:game"
Start-ServiceWindow -Title "Quiz Master Worker" -Command "pnpm dev:worker"

Write-Host ""
Write-Host "Started Quiz Master local services in separate PowerShell windows:"
Write-Host " - API"
Write-Host " - Frontend"
Write-Host " - Game"
Write-Host " - Worker"
Write-Host ""
Write-Host "Open http://localhost:3000 after the services finish booting."

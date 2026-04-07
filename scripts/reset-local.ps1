$ErrorActionPreference = "Stop"

Set-Location (Join-Path $PSScriptRoot "..")

Write-Host "Stopping containers and removing local volumes..."
docker compose down -v

Write-Host "Starting Postgres and Redis..."
docker compose up -d

Write-Host "Installing workspace dependencies..."
pnpm install

Write-Host "Running migrations..."
pnpm db:migrate

Write-Host "Seeding demo data..."
pnpm db:seed

Write-Host "Building workspace..."
pnpm -r build

Write-Host ""
Write-Host "Local reset completed."
Write-Host "Next commands:"
Write-Host "  pnpm dev:api"
Write-Host "  pnpm dev:game"
Write-Host "  pnpm dev:worker"
Write-Host "  pnpm dev:frontend"

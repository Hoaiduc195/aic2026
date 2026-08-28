# ====================================================================
# SCRIPT RESTORE DUMP DATABASE POSTGRESQL (Docker aic-postgres)
# ====================================================================
param(
    [string]$DumpPath = "C:\Users\VuiTrinhThiKim\Downloads\aic_local.dump",
    [string]$ContainerName = "aic-postgres",
    [string]$DbUser = "aic",
    [string]$DbName = "aic_local"
)

$rootDir = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
Set-Location $rootDir

Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host "   IMPORT DATABASE DUMP -> POSTGRES DOCKER" -ForegroundColor Cyan
Write-Host "==========================================================" -ForegroundColor Cyan

if (-not (Test-Path $DumpPath)) {
    Write-Host "[ERROR] Khong tim thay file dump tai: $DumpPath" -ForegroundColor Red
    exit 1
}

Write-Host "[1/3] Kiem tra container ${ContainerName}..." -ForegroundColor Yellow
$containerRunning = docker ps --filter "name=${ContainerName}" --filter "status=running" -q
if (-not $containerRunning) {
    Write-Host "[*] Container ${ContainerName} chua chay. Dang khoi dong..." -ForegroundColor Yellow
    docker compose up -d postgres
    Start-Sleep -Seconds 3
}

Write-Host "[2/3] Copying $DumpPath vao container..." -ForegroundColor Yellow
docker cp "$DumpPath" "${ContainerName}:/tmp/aic_local.dump"

if ($LASTEXITCODE -ne 0) {
    Write-Host "[ERROR] Copy file vao container that bai!" -ForegroundColor Red
    exit 1
}

Write-Host "[3/3] Dang chay pg_restore vao database $DbName..." -ForegroundColor Yellow
docker exec -i $ContainerName pg_restore -U $DbUser -d $DbName --clean --if-exists --no-owner --no-privileges -F c -v /tmp/aic_local.dump

Write-Host "[*] Don dep file dump tam trong container..." -ForegroundColor Gray
docker exec -i $ContainerName rm -f /tmp/aic_local.dump

Write-Host ""
Write-Host "Kiem tra ket qua: Row counts in key tables" -ForegroundColor Cyan
docker exec -i $ContainerName psql -U $DbUser -d $DbName -c "SELECT relname, n_live_tup FROM pg_stat_user_tables ORDER BY n_live_tup DESC LIMIT 10;"

Write-Host "==========================================================" -ForegroundColor Green
Write-Host "   DA RESTORE DATABASE HOAN TAT THANH CONG!" -ForegroundColor Green
Write-Host "==========================================================" -ForegroundColor Green

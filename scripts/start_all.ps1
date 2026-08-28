# ====================================================================
# SCRIPT KHOI DONG TOAN BO HE THONG AIC 2026 (Docker, Backend, Frontend)
# ====================================================================

# Tu dong xac dinh thu muc goc aic2026 (thu muc cha cua scripts/)
$rootDir = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
Set-Location $rootDir

function Test-ListeningPort {
    param([int]$Port)
    return [bool](Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue)
}

function Wait-HttpReady {
    param([string]$Uri, [int]$TimeoutSeconds = 60)
    for ($i = 0; $i -lt $TimeoutSeconds; $i += 1) {
        try {
            $response = Invoke-WebRequest -Uri $Uri -UseBasicParsing -TimeoutSec 2
            if ($response.StatusCode -ge 200 -and $response.StatusCode -lt 500) { return $true }
        } catch {}
        Start-Sleep -Seconds 1
    }
    return $false
}

function Test-FrontendAssetsReady {
    param([string]$BaseUri = 'http://127.0.0.1:3000')
    try {
        $page = Invoke-WebRequest -Uri "$BaseUri/" -UseBasicParsing -TimeoutSec 5
        if ($page.StatusCode -ne 200) { return $false }
        $match = [regex]::Match($page.Content, 'href="([^"]+\.css[^"]*)"')
        if (-not $match.Success) { return $false }
        $stylesheet = Invoke-WebRequest -Uri ($BaseUri + $match.Groups[1].Value) -UseBasicParsing -TimeoutSec 5
        return $stylesheet.StatusCode -eq 200 -and $stylesheet.Content.Length -gt 0
    } catch {
        return $false
    }
}

function Reset-ManagedFrontendDevServer {
    param([string]$FrontendDir)
    $listener = Get-NetTCPConnection -State Listen -LocalPort 3000 -ErrorAction SilentlyContinue |
        Select-Object -First 1
    if (-not $listener) { return $true }
    $process = Get-CimInstance Win32_Process -Filter "ProcessId=$($listener.OwningProcess)" -ErrorAction SilentlyContinue
    if (-not $process -or $process.CommandLine -notlike "*$FrontendDir*") {
        Write-Warning "Cong 3000 do process khac quan ly; khong tu dong dung PID $($listener.OwningProcess)."
        return $false
    }
    $targets = @($process.ProcessId, $process.ParentProcessId) | Where-Object { $_ } | Select-Object -Unique
    foreach ($processId in $targets) {
        $candidate = Get-CimInstance Win32_Process -Filter "ProcessId=$processId" -ErrorAction SilentlyContinue
        if ($candidate -and $candidate.CommandLine -like "*$FrontendDir*") {
            Stop-Process -Id $processId -Force -ErrorAction SilentlyContinue
        }
    }
    Start-Sleep -Seconds 2
    return -not (Test-ListeningPort -Port 3000)
}

function Move-StaleNextCache {
    param([string]$FrontendDir)
    $source = [IO.Path]::GetFullPath((Join-Path $FrontendDir '.next'))
    if (-not (Test-Path -LiteralPath $source)) { return }
    $prefix = [IO.Path]::GetFullPath($FrontendDir) + [IO.Path]::DirectorySeparatorChar
    if (-not $source.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Duong dan .next khong an toan.'
    }
    $destination = Join-Path $FrontendDir ('.next-stale-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
    Move-Item -LiteralPath $source -Destination $destination
    Write-Host "[*] Da chuyen cache Next loi sang: $destination" -ForegroundColor Yellow
}

Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host "   >>> DANG KHOI DONG TOAN BO HE THONG AIC 2026..." -ForegroundColor Cyan
Write-Host "   Thu muc goc: $rootDir" -ForegroundColor DarkGray
Write-Host "==========================================================" -ForegroundColor Cyan

# 1. Kiem tra Docker Daemon & Khoi dong Docker Containers
Write-Host "[1/3] Kiem tra va khoi dong Docker Containers..." -ForegroundColor Yellow

$dockerRunning = $false
try {
    $null = docker info 2>$null
    if ($LASTEXITCODE -eq 0) { $dockerRunning = $true }
} catch {
    $dockerRunning = $false
}

if (-not $dockerRunning) {
    Write-Host "[!] Docker Desktop chua chay. Dang thu bat Docker Desktop..." -ForegroundColor Yellow
    $dockerPaths = @(
        "C:\Program Files\Docker\Docker\Docker Desktop.exe",
        "$env:LOCALAPPDATA\Programs\Docker\Docker\Docker Desktop.exe"
    )
    foreach ($p in $dockerPaths) {
        if (Test-Path $p) {
            Start-Process $p
            break
        }
    }
    Write-Host "[*] Dang doi Docker Engine khoi dong (khoang 15s)..." -ForegroundColor Yellow
    $retry = 0
    while ($retry -lt 15) {
        Start-Sleep -Seconds 2
        try {
            $null = docker info 2>$null
            if ($LASTEXITCODE -eq 0) {
                $dockerRunning = $true
                break
            }
        } catch {}
        $retry++
    }
}

if ($dockerRunning) {
    Write-Host "[+] Docker Engine da san sang. Dang bat Postgres va Embedding..." -ForegroundColor Green
    # The nested embedding_services compose file used the same container_name.
    # Remove only an exited foreign container; volumes are intentionally preserved.
    $embeddingContainer = docker ps -a --filter "name=^aic-embedding$" --format "{{.Names}}"
    if ($embeddingContainer) {
        $embeddingInspect = docker inspect aic-embedding | ConvertFrom-Json
        $embeddingStatus = $embeddingInspect[0].State.Status
        $embeddingProject = $embeddingInspect[0].Config.Labels.'com.docker.compose.project'
        if ([string]::IsNullOrWhiteSpace($embeddingProject)) { $embeddingProject = '<unknown>' }
        if ($embeddingProject -ne 'aic2026') {
            Write-Host "[*] Chuyen container embedding ve compose chinh (project=$embeddingProject, status=$embeddingStatus); giu volume..." -ForegroundColor Yellow
            if ($embeddingStatus -eq 'running') {
                docker rm -f aic-embedding | Out-Null
            } else {
                docker rm aic-embedding | Out-Null
            }
        }
    }
    # Docker Compose's interactive progress renderer can remain attached in the
    # VS Code PowerShell terminal even after every detached container is running.
    # Plain progress is non-interactive and reliably returns control to this script.
    docker compose --progress plain up -d postgres embedding agent-prefilter
    if ($LASTEXITCODE -ne 0) { throw 'Docker compose khong khoi dong duoc cac service bat buoc.' }
    for ($attempt = 0; $attempt -lt 30; $attempt += 1) {
        $postgresHealth = docker inspect --format '{{.State.Health.Status}}' aic-postgres 2>$null
        if ($postgresHealth -eq 'healthy') { break }
        Start-Sleep -Seconds 1
    }
    if ($postgresHealth -ne 'healthy') { throw 'PostgreSQL chua healthy sau 30 giay.' }
} else {
    Write-Host "[!] KHONG THE KET NOI DOCKER. Vui long mo Docker Desktop thu cong!" -ForegroundColor Red
}

# 2. Khoi dong Backend (Port 4000)
Write-Host "[2/3] Khoi dong Backend API (Port 4000)..." -ForegroundColor Yellow
$backendDir = Join-Path $rootDir "apps\backend"
if ($dockerRunning) {
    Write-Host "[*] Cap nhat database migration (bao gom Temporal Zoom)..." -ForegroundColor Yellow
    Push-Location $backendDir
    try {
        & npm.cmd run db:migrate
        if ($LASTEXITCODE -ne 0) { throw "Database migration that bai voi ma $LASTEXITCODE" }
        & npm.cmd run db:verify
        if ($LASTEXITCODE -ne 0) { throw "Database verification that bai voi ma $LASTEXITCODE" }
    } finally {
        Pop-Location
    }
}
if (Test-ListeningPort -Port 4000) {
    Write-Host "[+] Backend da chay o cong 4000; bo qua khoi dong lai." -ForegroundColor Green
} else {
    $backendCmd = "cd '$backendDir'; Write-Host '=== BACKEND RETRIEVAL API (PORT 4000) ===' -ForegroundColor Green; npm run start:dev"
    Start-Process powershell -ArgumentList "-NoExit", "-Command", $backendCmd
    if (-not (Wait-HttpReady -Uri 'http://127.0.0.1:4000/health')) { Write-Warning 'Backend chua phan hoi health sau thoi gian cho.' }
}

# 3. Khoi dong Frontend (Port 3000)
Write-Host "[3/3] Khoi dong Frontend Workbench (Port 3000)..." -ForegroundColor Yellow
$frontendDir = Join-Path $rootDir "apps\frontend"
if (Test-ListeningPort -Port 3000) {
    if (Test-FrontendAssetsReady) {
        Write-Host "[+] Frontend va CSS da san sang o cong 3000; bo qua khoi dong lai." -ForegroundColor Green
    } else {
        Write-Host "[!] Frontend co HTML nhung asset CSS hong; dang khoi dong lai cache sach..." -ForegroundColor Yellow
        if (Reset-ManagedFrontendDevServer -FrontendDir $frontendDir) {
            Move-StaleNextCache -FrontendDir $frontendDir
        }
    }
}
if (-not (Test-ListeningPort -Port 3000)) {
    $frontendCmd = "cd '$frontendDir'; `$env:NODE_OPTIONS = '--max-old-space-size=4096'; Write-Host '=== FRONTEND WORKBENCH (PORT 3000) ===' -ForegroundColor Green; npm run dev"
    Start-Process powershell -ArgumentList "-NoExit", "-Command", $frontendCmd
    if (-not (Wait-HttpReady -Uri 'http://127.0.0.1:3000/')) {
        Write-Warning 'Frontend chua phan hoi sau thoi gian cho.'
    } elseif (-not (Test-FrontendAssetsReady)) {
        Write-Warning 'Frontend tra HTML nhung CSS chua san sang; xem terminal frontend.'
    }
}

# 4. Thong bao hoan tat
Start-Sleep -Seconds 3
Write-Host "==========================================================" -ForegroundColor Green
Write-Host "   [OK] TOAN BO HE THONG DA DUOC KHOI DONG THANH CONG!" -ForegroundColor Green
Write-Host "==========================================================" -ForegroundColor Green
Write-Host " - Frontend Workbench : http://127.0.0.1:3000" -ForegroundColor White
Write-Host " - Backend API        : http://127.0.0.1:4000" -ForegroundColor White
Write-Host " - Embedding Service  : http://127.0.0.1:8001" -ForegroundColor White
Write-Host " - Agent Prefilter    : http://127.0.0.1:8002" -ForegroundColor White
Write-Host " - PostgreSQL         : localhost:5433" -ForegroundColor White
Write-Host "==========================================================" -ForegroundColor Green

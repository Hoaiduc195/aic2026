[CmdletBinding()]
param(
    [string]$Query,
    [ValidateSet('textual_kis', 'vqa', 'trake')]
    [string]$Task = 'textual_kis',
    [ValidateSet('fast', 'balanced', 'accurate')]
    [string]$Profile = 'balanced',
    [string]$Model = 'gpt-5.6-luna',
    [ValidateRange(1, 100)]
    [int]$TopK = 10,
    [ValidateRange(1, 50)]
    [int]$VideoBudget = 10,
    [ValidateRange(1, 32)]
    [int]$BatchSize = 8,
    [ValidateRange(0, 100000)]
    [int]$MaxBatches = 0,
    [string]$RunId,
    [string]$WorkerId = "worker-$([Guid]::NewGuid().ToString('N').Substring(0, 8))",
    [switch]$Pilot,
    [switch]$Yes,
    [bool]$AutoStartBackend = $true
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$backendDir = Join-Path $repoRoot 'apps\backend'
$envFile = Join-Path $backendDir '.env'
$runtimeDir = Join-Path $repoRoot 'data\tmp\agent-worker'

function Test-DotEnvKey {
    param([string[]]$Names)
    if (-not (Test-Path -LiteralPath $envFile)) { return $false }
    foreach ($line in Get-Content -LiteralPath $envFile) {
        foreach ($name in $Names) {
            if ($line -match "^$([Regex]::Escape($name))=(.+)$" -and $Matches[1].Trim()) {
                return $true
            }
        }
    }
    return $false
}

function Test-HttpEndpoint {
    param([string]$Uri, [int]$TimeoutSec = 2)
    try {
        Invoke-RestMethod -Uri $Uri -TimeoutSec $TimeoutSec | Out-Null
        return $true
    } catch {
        return $false
    }
}

if (-not (Test-Path -LiteralPath $backendDir)) {
    throw "Khong tim thay backend: $backendDir"
}
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    throw 'Khong tim thay Node.js trong PATH.'
}
if (-not (Get-Command npm.cmd -ErrorAction SilentlyContinue)) {
    throw 'Khong tim thay npm trong PATH.'
}
if (-not $RunId -and -not $Query.Trim()) {
    $Query = Read-Host 'Nhap cau query can tim frame'
}
if (-not $RunId -and -not $Query.Trim()) {
    throw 'Query khong duoc de trong khi khong resume bang RunId.'
}
if ($WorkerId -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$') {
    throw 'WorkerId chi duoc chua chu, so, dau cham, gach duoi va gach ngang.'
}

$profiles = @{
    fast = @{
        Reasoning = 'none'; Detail = 'low'; MaxTokens = '80'; Concurrency = '4'; Timeout = '30000'
    }
    balanced = @{
        Reasoning = 'low'; Detail = 'low'; MaxTokens = '128'; Concurrency = '2'; Timeout = '45000'
    }
    accurate = @{
        Reasoning = 'medium'; Detail = 'high'; MaxTokens = '192'; Concurrency = '1'; Timeout = '90000'
    }
}
$selected = $profiles[$Profile]

$env:AGENT_WORKER_VLM_BASE_URL = 'https://api.openai.com/v1'
$env:AGENT_WORKER_VLM_MODEL = $Model
$env:AGENT_WORKER_REASONING_EFFORT = $selected.Reasoning
$env:AGENT_WORKER_IMAGE_DETAIL = $selected.Detail
$env:AGENT_WORKER_VLM_MAX_TOKENS = $selected.MaxTokens
$env:AGENT_WORKER_VLM_CONCURRENCY = $selected.Concurrency
$env:AGENT_WORKER_VLM_TIMEOUT_MS = $selected.Timeout

$hasApiKey = [bool]$env:AGENT_WORKER_VLM_API_KEY -or [bool]$env:OPENAI_API_KEY -or
    (Test-DotEnvKey @('AGENT_WORKER_VLM_API_KEY', 'OPENAI_API_KEY'))
if (-not $hasApiKey) {
    throw @"
Chua tim thay OpenAI API key. Them mot trong hai dong sau vao apps/backend/.env:
AGENT_WORKER_VLM_API_KEY=<secret>
hoac OPENAI_API_KEY=<secret>
Khong commit file .env.
"@
}

if ($Pilot -and $MaxBatches -eq 0) { $MaxBatches = 1 }

Write-Host ''
Write-Host '=== AIC Agent Worker ===' -ForegroundColor Cyan
Write-Host "Mode          : $(if ($RunId) { 'resume' } else { 'new run' })"
if ($RunId) { Write-Host "Run ID        : $RunId" } else { Write-Host "Query         : $Query" }
Write-Host "Task          : $Task"
Write-Host "Profile       : $Profile"
Write-Host "Model         : $Model"
Write-Host "Reasoning     : $($selected.Reasoning)"
Write-Host "Image detail  : $($selected.Detail)"
Write-Host "Top-K/videos  : $TopK / $VideoBudget"
Write-Host "Batch/limit   : $BatchSize / $(if ($MaxBatches) { $MaxBatches } else { 'unlimited' })"
Write-Host "Worker ID     : $WorkerId"
Write-Host ''

if (-not $Yes) {
    $answer = Read-Host 'Bat dau chay? (y/N)'
    if ($answer -notmatch '^(y|yes)$') {
        Write-Host 'Da huy.'
        exit 0
    }
}

if (-not (Test-HttpEndpoint 'http://localhost:4000/health')) {
    if (-not $AutoStartBackend) {
        throw 'Backend chua chay tai http://localhost:4000.'
    }
    New-Item -ItemType Directory -Force -Path $runtimeDir | Out-Null
    $backendOut = Join-Path $runtimeDir 'backend.out.log'
    $backendErr = Join-Path $runtimeDir 'backend.err.log'
    Write-Host 'Backend chua chay; dang khoi dong nen...' -ForegroundColor Yellow
    Start-Process -FilePath 'npm.cmd' -ArgumentList @('run', 'start:dev') `
        -WorkingDirectory $backendDir -WindowStyle Hidden `
        -RedirectStandardOutput $backendOut -RedirectStandardError $backendErr | Out-Null
    $ready = $false
    for ($attempt = 0; $attempt -lt 60; $attempt += 1) {
        Start-Sleep -Milliseconds 500
        if (Test-HttpEndpoint 'http://localhost:4000/health') {
            $ready = $true
            break
        }
    }
    if (-not $ready) {
        throw "Backend khong san sang sau 30 giay. Xem log: $backendErr"
    }
}

if (-not (Test-HttpEndpoint 'http://localhost:8001/health')) {
    Write-Warning 'Embedding service local tai cong 8001 chua phan hoi; CLIP retrieval co the degraded.'
}

$workerArgs = @('run', 'agent:worker', '--')
if ($RunId) {
    $workerArgs += @('--run-id', $RunId)
} else {
    $workerArgs += @(
        '--query', $Query,
        '--task', $Task,
        '--top-k', [string]$TopK,
        '--video-budget', [string]$VideoBudget,
        '--batch-size', [string]$BatchSize
    )
}
$workerArgs += @('--worker-id', $WorkerId)
if ($MaxBatches -gt 0) { $workerArgs += @('--max-batches', [string]$MaxBatches) }

Push-Location $backendDir
try {
    & npm.cmd @workerArgs
    if ($LASTEXITCODE -ne 0) { throw "Agent worker thoat voi ma loi $LASTEXITCODE" }
} finally {
    Pop-Location
}

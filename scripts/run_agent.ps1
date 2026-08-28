[CmdletBinding()]
param(
    [string]$Query,
    [ValidateSet('textual_kis', 'vqa', 'trake')]
    [string]$Task = 'textual_kis',
    [ValidateSet('fast', 'balanced', 'accurate')]
    [string]$Profile = 'fast',
    [ValidateSet('sparse', 'temporal_zoom', 'dense')]
    [string]$ScanMode = 'temporal_zoom',
    [string]$Model,
    [string]$BaseUrl,
    [ValidateRange(1, 100)]
    [int]$TopK = 30,
    [ValidateRange(1, 50)]
    [int]$VideoBudget = 3,
    [ValidateRange(1, 512)]
    [int]$BatchSize = 16,
    [ValidateRange(5, 120)]
    [int]$TemporalWindowSeconds = 20,
    [ValidateRange(0, 120)]
    [int]$TemporalMergeGapSeconds = 15,
    [ValidateRange(1, 10)]
    [int]$TemporalWindowsPerVideo = 2,
    [ValidateRange(1, 5)]
    [int]$TemporalSampleFps = 1,
    [ValidateRange(0.5, 10)]
    [double]$TemporalFinalRadiusSeconds = 2,
    [ValidateRange(0.5, 1)]
    [double]$TemporalStopScore = 0.82,
    [ValidateRange(30, 1800)]
    [int]$TemporalDeadlineSeconds = 300,
    [ValidateRange(0.001, 0.5)]
    [double]$PrefilterCandidateRatio = 0.05,
    [ValidateRange(0.0001, 0.2)]
    [double]$VlmCandidateRatio = 0.005,
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
        Reasoning = 'none'; Detail = 'low'; MaxTokens = '512'; Concurrency = '4'; Timeout = '30000'; StoryboardColumns = '4'
    }
    balanced = @{
        Reasoning = 'low'; Detail = 'low'; MaxTokens = '768'; Concurrency = '2'; Timeout = '60000'; StoryboardColumns = '4'
    }
    accurate = @{
        # A 2x2 low-detail storyboard is clearer and more reliable through the
        # current provider than one large high-detail request, which often times out.
        Reasoning = 'low'; Detail = 'low'; MaxTokens = '1024'; Concurrency = '1'; Timeout = '90000'; StoryboardColumns = '2'
    }
}
$selected = $profiles[$Profile]
if (-not $RunId -and $Profile -eq 'balanced') {
    if (-not $PSBoundParameters.ContainsKey('TopK')) { $TopK = 50 }
    if (-not $PSBoundParameters.ContainsKey('VideoBudget')) { $VideoBudget = 5 }
    if (-not $PSBoundParameters.ContainsKey('TemporalWindowSeconds')) { $TemporalWindowSeconds = 30 }
    if (-not $PSBoundParameters.ContainsKey('TemporalWindowsPerVideo')) { $TemporalWindowsPerVideo = 3 }
    if (-not $PSBoundParameters.ContainsKey('TemporalSampleFps')) { $TemporalSampleFps = 2 }
    if (-not $PSBoundParameters.ContainsKey('TemporalStopScore')) { $TemporalStopScore = 0.78 }
    if (-not $PSBoundParameters.ContainsKey('TemporalDeadlineSeconds')) { $TemporalDeadlineSeconds = 420 }
}
if (-not $RunId -and $Profile -eq 'accurate') {
    if (-not $PSBoundParameters.ContainsKey('TopK')) { $TopK = 100 }
    if (-not $PSBoundParameters.ContainsKey('VideoBudget')) { $VideoBudget = 10 }
    if (-not $PSBoundParameters.ContainsKey('TemporalWindowSeconds')) { $TemporalWindowSeconds = 45 }
    if (-not $PSBoundParameters.ContainsKey('TemporalMergeGapSeconds')) { $TemporalMergeGapSeconds = 20 }
    if (-not $PSBoundParameters.ContainsKey('TemporalWindowsPerVideo')) { $TemporalWindowsPerVideo = 4 }
    if (-not $PSBoundParameters.ContainsKey('TemporalSampleFps')) { $TemporalSampleFps = 2 }
    if (-not $PSBoundParameters.ContainsKey('TemporalFinalRadiusSeconds')) { $TemporalFinalRadiusSeconds = 3 }
    if (-not $PSBoundParameters.ContainsKey('TemporalStopScore')) { $TemporalStopScore = 0.88 }
    if (-not $PSBoundParameters.ContainsKey('TemporalDeadlineSeconds')) { $TemporalDeadlineSeconds = 600 }
    if (-not $PSBoundParameters.ContainsKey('BatchSize')) { $BatchSize = 4 }
}
# Chỉ ghi đè cấu hình khi người dùng truyền tham số. Nếu bỏ trống,
# worker sẽ đọc AGENT_WORKER_VLM_BASE_URL/AGENT_WORKER_VLM_MODEL từ apps/backend/.env.
if (-not [string]::IsNullOrWhiteSpace($BaseUrl)) {
    $env:AGENT_WORKER_VLM_BASE_URL = $BaseUrl.Trim()
} else {
    # Không để giá trị override còn sót lại từ một lần chạy trước thắng .env.
    Remove-Item Env:AGENT_WORKER_VLM_BASE_URL -ErrorAction SilentlyContinue
}
if (-not [string]::IsNullOrWhiteSpace($Model)) {
    $env:AGENT_WORKER_VLM_MODEL = $Model.Trim()
} else {
    # dotenv không ghi đè biến đã tồn tại; xóa override cũ để đọc model trong .env.
    Remove-Item Env:AGENT_WORKER_VLM_MODEL -ErrorAction SilentlyContinue
}
$env:AGENT_WORKER_REASONING_EFFORT = $selected.Reasoning
$env:AGENT_WORKER_IMAGE_DETAIL = $selected.Detail
$env:AGENT_WORKER_VLM_MAX_TOKENS = $selected.MaxTokens
$env:AGENT_WORKER_VLM_CONCURRENCY = $selected.Concurrency
$env:AGENT_WORKER_VLM_TIMEOUT_MS = $selected.Timeout
$env:AGENT_STORYBOARD_COLUMNS = $selected.StoryboardColumns
$env:AGENT_PREFILTER_CANDIDATE_RATIO = [string]$PrefilterCandidateRatio
$env:AGENT_VLM_CANDIDATE_RATIO = [string]$VlmCandidateRatio
$env:AGENT_TEMPORAL_FINAL_RADIUS_SECONDS = [string]$TemporalFinalRadiusSeconds
$env:AGENT_TEMPORAL_STOP_SCORE = [string]$TemporalStopScore
$env:AGENT_TEMPORAL_DEADLINE_SECONDS = [string]$TemporalDeadlineSeconds

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
Write-Host "Scan mode     : $ScanMode"
Write-Host "Base URL      : $(if (-not [string]::IsNullOrWhiteSpace($BaseUrl)) { $BaseUrl.Trim() } else { 'apps/backend/.env' })"
Write-Host "Model         : $(if (-not [string]::IsNullOrWhiteSpace($Model)) { $Model.Trim() } else { 'apps/backend/.env' })"
Write-Host "Reasoning     : $($selected.Reasoning)"
Write-Host "Image detail  : $($selected.Detail)"
Write-Host "VLM budget    : $($selected.MaxTokens) tokens | storyboard $($selected.StoryboardColumns) columns"
Write-Host "Top-K/videos  : $TopK / $VideoBudget"
Write-Host "Batch/limit   : $BatchSize / $(if ($MaxBatches) { $MaxBatches } else { 'unlimited' })"
Write-Host "Cascade ratio : prefilter $PrefilterCandidateRatio | VLM $VlmCandidateRatio"
if ($ScanMode -eq 'temporal_zoom') {
    Write-Host "Temporal      : +-$TemporalWindowSeconds sec | $TemporalWindowsPerVideo windows/video | $TemporalSampleFps FPS"
    Write-Host "Zoom/stop     : +-$TemporalFinalRadiusSeconds sec | score $TemporalStopScore | deadline $TemporalDeadlineSeconds sec"
}
Write-Host "Worker ID     : $WorkerId"
if ($RunId) {
    Write-Warning 'Resume giu nguyen Top-K/video/batch/window da luu trong run. Muon doi profile pham vi, hay tao run moi.'
}
Write-Host ''

if (-not $Yes) {
    $answer = Read-Host 'Bat dau chay? (y/N)'
    if ($answer -notmatch '^(y|yes)$') {
        Write-Host 'Da huy.'
        exit 0
    }
}

if (-not (Test-HttpEndpoint 'http://127.0.0.1:4000/health')) {
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
        if (Test-HttpEndpoint 'http://127.0.0.1:4000/health') {
            $ready = $true
            break
        }
    }
    if (-not $ready) {
        throw "Backend khong san sang sau 30 giay. Xem log: $backendErr"
    }
}

if (-not (Test-HttpEndpoint 'http://127.0.0.1:8001/health')) {
    Write-Warning 'Embedding service local tai cong 8001 chua phan hoi; CLIP retrieval co the degraded.'
}
if (-not (Test-HttpEndpoint 'http://127.0.0.1:8002/health')) {
    throw 'Agent prefilter service tai cong 8002 chua san sang. Chay .\scripts\start_all.ps1 roi thu lai.'
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
        '--batch-size', [string]$BatchSize,
        '--scan-mode', $ScanMode,
        '--temporal-window-seconds', [string]$TemporalWindowSeconds,
        '--temporal-merge-gap-seconds', [string]$TemporalMergeGapSeconds,
        '--temporal-windows-per-video', [string]$TemporalWindowsPerVideo,
        '--temporal-sample-fps', [string]$TemporalSampleFps
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

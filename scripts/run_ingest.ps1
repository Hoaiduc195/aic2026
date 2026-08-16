[CmdletBinding()]
param(
    [string]$DataRoot,
    [string]$DatabaseUrl,
    [string]$IndexVersion = 'aic2026-local-v1',
    [string[]]$VideoId = @(),
    [ValidateRange(0, [int]::MaxValue)]
    [int]$LimitVideos = 0,
    [switch]$DryRun,
    [switch]$InstallPythonDependencies,
    [switch]$SkipMigration,
    [switch]$SkipIndexes,
    [switch]$SkipVerify
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$defaultDataRoot = Join-Path $repoRoot 'data\refined'
if (-not (Test-Path -LiteralPath $defaultDataRoot -PathType Container)) {
    $defaultDataRoot = Join-Path (Split-Path $repoRoot -Parent) 'data\refined'
}
$resolvedDataRoot = if ([string]::IsNullOrWhiteSpace($DataRoot)) { $defaultDataRoot } else { $DataRoot }

if (-not (Test-Path -LiteralPath $resolvedDataRoot -PathType Container)) {
    throw "Refined data directory does not exist: $resolvedDataRoot"
}
$resolvedDataRoot = (Resolve-Path -LiteralPath $resolvedDataRoot).Path

$pythonPath = Join-Path $repoRoot 'venv\Scripts\python.exe'
if (-not (Test-Path -LiteralPath $pythonPath -PathType Leaf)) {
    $pythonPath = (Get-Command python -ErrorAction Stop).Source
}

if ([string]::IsNullOrWhiteSpace($DatabaseUrl)) {
    $DatabaseUrl = $env:DATABASE_URL
}
if ([string]::IsNullOrWhiteSpace($DatabaseUrl) -and -not $DryRun) {
    throw 'Set DATABASE_URL or pass -DatabaseUrl before running the database import.'
}

$env:PYTHONPATH = $repoRoot

function Invoke-Step {
    param(
        [Parameter(Mandatory)]
        [string]$Description,
        [Parameter(Mandatory)]
        [string]$FilePath,
        [Parameter(Mandatory)]
        [string[]]$ArgumentList
    )

    Write-Host "==> $Description"
    & $FilePath @ArgumentList
    if ($LASTEXITCODE -ne 0) {
        throw "$Description failed with exit code $LASTEXITCODE"
    }
}

Push-Location $repoRoot
try {
    if ($InstallPythonDependencies) {
        Invoke-Step `
            -Description 'Install Python ingestion dependencies' `
            -FilePath $pythonPath `
            -ArgumentList @('-m', 'pip', 'install', '-r', 'pipelines\ingestion\requirements.txt')
    }

    $importArguments = @(
        '-m', 'pipelines.ingestion.import_refined',
        '--data-root', $resolvedDataRoot
    )

    if ($DryRun) {
        $importArguments += '--dry-run'
        Invoke-Step `
            -Description 'Validate refined artifacts (dry run)' `
            -FilePath $pythonPath `
            -ArgumentList $importArguments
        return
    }

    if (-not $SkipMigration) {
        Invoke-Step `
            -Description 'Apply database migrations' `
            -FilePath 'pnpm' `
            -ArgumentList @('--dir', 'apps/backend', 'db:migrate')
    }

    $importArguments += @('--database-url', $DatabaseUrl, '--index-version', $IndexVersion)
    foreach ($id in $VideoId) {
        $importArguments += @('--video-id', $id)
    }
    if ($LimitVideos -gt 0) {
        $importArguments += @('--limit-videos', [string]$LimitVideos)
    }

    Invoke-Step `
        -Description 'Import refined artifacts' `
        -FilePath $pythonPath `
        -ArgumentList $importArguments

    if (-not $SkipIndexes) {
        Invoke-Step `
            -Description 'Build database indexes' `
            -FilePath 'pnpm' `
            -ArgumentList @('--dir', 'apps/backend', 'db:build-indexes')
    }

    if (-not $SkipVerify) {
        Invoke-Step `
            -Description 'Verify database schema' `
            -FilePath 'pnpm' `
            -ArgumentList @('--dir', 'apps/backend', 'db:verify')
    }

    Write-Host 'Ingest completed successfully.'
}
finally {
    Pop-Location
}

#Requires -Version 5.1
<#
  Baut die Desktop-Release fuer LatexIDE:
   1. Staging-Ordner installer\out\staging zusammenstellen (Client ohne dist,
      Server, package.json/-lock, build.js) und dort npm ci / node build.js /
      npm prune --omit=dev ausfuehren.
   2. Offizielles Node 24 LTS win-x64 ZIP laden (SHA256 gegen SHASUMS256.txt
      pruefen) und nach staging\node entpacken (inkl. LICENSE).
   3. Windows-Installer per Inno Setup (ISCC.exe) bauen, falls vorhanden.
   4. Zusaetzlich installer\out\LatexIDE-macOS.zip erzeugen (Staging ohne
      Windows-Node, dafuer mit installer\macos\install.command).

  Nutzung:
    powershell -File installer\build-release.ps1              # voller Build
    powershell -File installer\build-release.ps1 -StagingOnly # nur Schritt 1 (kein npm ci noetig - siehe -WhatIf)
    powershell -File installer\build-release.ps1 -WhatIf      # nur anzeigen, was kopiert wuerde
#>

param(
    [switch]$StagingOnly,
    [switch]$WhatIf,
    [string]$NodeVersion = "24.21.0"
)

$ErrorActionPreference = 'Stop'

$RepoRoot = Split-Path -Parent $PSScriptRoot
$InstallerDir = $PSScriptRoot
$OutDir = Join-Path $InstallerDir 'out'
$StagingDir = Join-Path $OutDir 'staging'

function Write-Step($msg) {
    Write-Host "=== $msg ===" -ForegroundColor Cyan
}

# --- 1. Staging zusammenstellen -------------------------------------------

Write-Step "Staging-Ordner vorbereiten: $StagingDir"

if ($WhatIf) {
    Write-Host "[WhatIf] Wuerde loeschen und neu anlegen: $StagingDir"
} else {
    if (Test-Path $StagingDir) {
        Remove-Item -Path $StagingDir -Recurse -Force
    }
    New-Item -ItemType Directory -Force -Path $StagingDir | Out-Null
}

function Copy-ToStaging($relSource, $relDest, [string[]]$excludeDirs = @()) {
    $src = Join-Path $RepoRoot $relSource
    $dst = Join-Path $StagingDir $relDest
    if ($WhatIf) {
        Write-Host "[WhatIf] Kopiere $relSource -> installer\out\staging\$relDest (exclude: $($excludeDirs -join ', '))"
        return
    }
    if (Test-Path $src -PathType Container) {
        New-Item -ItemType Directory -Force -Path $dst | Out-Null
        Get-ChildItem -Path $src -Force | ForEach-Object {
            if ($excludeDirs -contains $_.Name) { return }
            $itemDst = Join-Path $dst $_.Name
            if ($_.PSIsContainer) {
                Copy-Item -Path $_.FullName -Destination $itemDst -Recurse -Force
            } else {
                Copy-Item -Path $_.FullName -Destination $itemDst -Force
            }
        }
    } else {
        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $dst) | Out-Null
        Copy-Item -Path $src -Destination $dst -Force
    }
}

Copy-ToStaging 'client' 'client' -excludeDirs @('dist')
Copy-ToStaging 'server' 'server'
Copy-ToStaging 'package.json' 'package.json'
Copy-ToStaging 'package-lock.json' 'package-lock.json'
Copy-ToStaging 'build.js' 'build.js'
Copy-ToStaging 'LICENSE' 'LICENSE'
Copy-ToStaging 'THIRD_PARTY_NOTICES.md' 'THIRD_PARTY_NOTICES.md'
Copy-ToStaging (Join-Path 'installer\windows' 'install-texlive.ps1') 'install-texlive.ps1'
Copy-ToStaging (Join-Path 'installer\windows' 'LatexIDE.cmd') 'LatexIDE.cmd'
Copy-ToStaging (Join-Path 'installer\windows' 'LatexIDE-Server.cmd') 'LatexIDE-Server.cmd'
Copy-ToStaging (Join-Path 'installer\windows' 'LatexIDE-Lokal.vbs') 'LatexIDE-Lokal.vbs'

if ($WhatIf) {
    Write-Host "[WhatIf] Trockenlauf beendet - kein npm ci / build / prune ausgefuehrt."
    return
}

if ($StagingOnly) {
    Write-Host "Nur Staging-Kopie ausgefuehrt (-StagingOnly). npm ci / build.js / prune uebersprungen."
    exit 0
}

# --- 2. npm ci / build / prune im Staging ----------------------------------

Write-Step "npm ci in staging"
Push-Location $StagingDir
try {
    npm ci
    if ($LASTEXITCODE -ne 0) { throw "npm ci fehlgeschlagen (Exit $LASTEXITCODE)" }

    Write-Step "node build.js (Client-Bundle bauen)"
    node build.js
    if ($LASTEXITCODE -ne 0) { throw "node build.js fehlgeschlagen (Exit $LASTEXITCODE)" }

    # optional raus: @napi-rs/canvas braucht nur pdf.js unter Node, die App nutzt pdf.js im Browser.
    Write-Step "npm prune --omit=dev --omit=optional"
    npm prune --omit=dev --omit=optional
    if ($LASTEXITCODE -ne 0) { throw "npm prune fehlgeschlagen (Exit $LASTEXITCODE)" }
} finally {
    Pop-Location
}

# --- 3. Node 24 LTS win-x64 laden und pruefen ------------------------------

Write-Step "Node.js $NodeVersion (win-x64) laden"

$NodeDistBase = "https://nodejs.org/dist/v$NodeVersion"
$NodeZipName = "node-v$NodeVersion-win-x64.zip"
$TmpDir = Join-Path $env:LOCALAPPDATA "Temp\latex-installer-test"
New-Item -ItemType Directory -Force -Path $TmpDir | Out-Null
$NodeZipPath = Join-Path $TmpDir $NodeZipName
$ShaSumsPath = Join-Path $TmpDir 'SHASUMS256.txt'

Invoke-WebRequest -Uri "$NodeDistBase/$NodeZipName" -OutFile $NodeZipPath -UseBasicParsing
Invoke-WebRequest -Uri "$NodeDistBase/SHASUMS256.txt" -OutFile $ShaSumsPath -UseBasicParsing

$expectedLine = Select-String -Path $ShaSumsPath -Pattern ([regex]::Escape($NodeZipName)) | Select-Object -First 1
if (-not $expectedLine) {
    throw "Konnte $NodeZipName nicht in SHASUMS256.txt finden."
}
$expectedHash = ($expectedLine.Line -split '\s+')[0].ToLower()
$actualHash = (Get-FileHash -Path $NodeZipPath -Algorithm SHA256).Hash.ToLower()

if ($expectedHash -ne $actualHash) {
    throw "SHA256-Mismatch fuer $NodeZipName!`nErwartet: $expectedHash`nErhalten: $actualHash"
}
Write-Host "SHA256 OK: $NodeZipName"

$NodeExtractDir = Join-Path $TmpDir 'node-extract'
if (Test-Path $NodeExtractDir) { Remove-Item -Path $NodeExtractDir -Recurse -Force }
Expand-Archive -Path $NodeZipPath -DestinationPath $NodeExtractDir -Force

$NodeSrcDir = Get-ChildItem -Path $NodeExtractDir -Directory | Select-Object -First 1
$NodeDestDir = Join-Path $StagingDir 'node'
if (Test-Path $NodeDestDir) { Remove-Item -Path $NodeDestDir -Recurse -Force }
Copy-Item -Path $NodeSrcDir.FullName -Destination $NodeDestDir -Recurse -Force

if (-not (Test-Path (Join-Path $NodeDestDir 'LICENSE'))) {
    Write-Warning "LICENSE-Datei nicht im Node-ZIP gefunden - bitte manuell pruefen."
}
if (-not (Test-Path (Join-Path $NodeDestDir 'node.exe'))) {
    throw "node.exe nicht im entpackten Node-Ordner gefunden."
}
Write-Host "Node.js nach $NodeDestDir kopiert."

# --- 4. Inno Setup Compiler aufrufen (falls vorhanden) ---------------------

Write-Step "Windows-Installer bauen (Inno Setup)"

$IsccCandidates = @(
    $env:ISCC,
    "${env:ProgramFiles(x86)}\Inno Setup 7\ISCC.exe",
    "$env:ProgramFiles\Inno Setup 7\ISCC.exe",
    "$env:LOCALAPPDATA\Programs\Inno Setup 7\ISCC.exe",
    "${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe",
    "$env:LOCALAPPDATA\Programs\Inno Setup 6\ISCC.exe"
)
$Iscc = $IsccCandidates | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1

if ($Iscc) {
    $AppVersion = (Get-Content (Join-Path $RepoRoot 'package.json') -Raw | ConvertFrom-Json).version
    & $Iscc "/DMyAppVersion=$AppVersion" (Join-Path $InstallerDir 'windows\LatexIDE.iss')
    if ($LASTEXITCODE -ne 0) { throw "ISCC.exe fehlgeschlagen (Exit $LASTEXITCODE)" }
    Write-Host "Installer erzeugt unter installer\out\LatexIDE-Setup.exe"
} else {
    Write-Warning "Inno Setup 6 (ISCC.exe) nicht gefunden. Bitte installieren:"
    Write-Warning "  https://jrsoftware.org/isdl.php"
    Write-Warning "Erwartete Pfade: `"${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe`" oder `"$env:LOCALAPPDATA\Programs\Inno Setup 6\ISCC.exe`""
    Write-Warning "Staging-Ordner ist fertig unter: $StagingDir - Installer-Build wird uebersprungen."
}

# --- 5. macOS-ZIP zusammenstellen ------------------------------------------

Write-Step "macOS-Paket erzeugen: installer\out\LatexIDE-macOS.zip"

# Temp statt out/: Nextcloud/AV sperrt sonst Dateien waehrend Compress-Archive
$MacStagingDir = Join-Path $env:TEMP 'latexide-staging-macos'
if (Test-Path $MacStagingDir) { Remove-Item -Path $MacStagingDir -Recurse -Force }
New-Item -ItemType Directory -Force -Path $MacStagingDir | Out-Null

Get-ChildItem -Path $StagingDir -Force | ForEach-Object {
    if ($_.Name -in @('node', 'install-texlive.ps1', 'LatexIDE.cmd', 'LatexIDE-Server.cmd', 'LatexIDE-Lokal.vbs')) { return }
    $dst = Join-Path $MacStagingDir $_.Name
    if ($_.PSIsContainer) {
        Copy-Item -Path $_.FullName -Destination $dst -Recurse -Force
    } else {
        Copy-Item -Path $_.FullName -Destination $dst -Force
    }
}
Copy-Item -Path (Join-Path $InstallerDir 'macos\install.command') -Destination (Join-Path $MacStagingDir 'install.command') -Force
Copy-Item -Path (Join-Path $InstallerDir 'LICENSES-INSTALLER.txt') -Destination (Join-Path $MacStagingDir 'LICENSES-INSTALLER.txt') -Force

$MacZipPath = Join-Path $OutDir 'LatexIDE-macOS.zip'
if (Test-Path $MacZipPath) { Remove-Item -Path $MacZipPath -Force }
Compress-Archive -Path (Join-Path $MacStagingDir '*') -DestinationPath $MacZipPath -Force
Remove-Item -Path $MacStagingDir -Recurse -Force

Write-Host "macOS-Paket erzeugt: $MacZipPath"
Write-Step "Fertig."

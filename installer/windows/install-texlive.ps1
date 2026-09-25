#Requires -Version 5.1
<#
  Installiert TeX Live 2025 (scheme-full) per-user unter
  %LOCALAPPDATA%\LatexIDE\texlive\2025, falls noch keine latexmk
  Installation gefunden wird. Wird vom Inno-Setup-Installer nach dem
  Kopieren der App-Dateien aufgerufen (sichtbares Fenster, dauert lange:
  ca. 4-5 GB Download, mehrere Stunden je nach Verbindung).
#>

$ErrorActionPreference = 'Stop'

$TexDir = Join-Path $env:LOCALAPPDATA 'LatexIDE\texlive\2025'
$ExistingLatexmk = Join-Path $TexDir 'bin\windows\latexmk.exe'

function Test-LatexmkOnPath {
    $cmd = Get-Command latexmk.exe -ErrorAction SilentlyContinue
    return $null -ne $cmd
}

if (Test-LatexmkOnPath) {
    Write-Host "latexmk bereits im PATH gefunden - TeX-Live-Installation wird uebersprungen."
    exit 0
}

if (Test-Path $ExistingLatexmk) {
    Write-Host "TeX Live 2025 bereits unter $TexDir installiert - Installation wird uebersprungen."
    exit 0
}

$Repo = 'https://ftp.tu-chemnitz.de/pub/tug/historic/systems/texlive/2025/tlnet-final'
$WorkDir = Join-Path $env:TEMP 'LatexIDE-texlive-install'
$ZipPath = Join-Path $WorkDir 'install-tl.zip'
$ExtractDir = Join-Path $WorkDir 'extracted'
$ProfilePath = Join-Path $WorkDir 'texlive.profile'

Write-Host "=== LatexIDE: TeX Live 2025 (scheme-full) wird installiert ==="
Write-Host "Zielverzeichnis: $TexDir"
Write-Host "Quelle: $Repo"
Write-Host "Achtung: Download ca. 4-5 GB, kann mehrere Stunden dauern."

New-Item -ItemType Directory -Force -Path $WorkDir | Out-Null
New-Item -ItemType Directory -Force -Path $ExtractDir | Out-Null

Write-Host "Lade install-tl.zip..."
Invoke-WebRequest -Uri "$Repo/install-tl.zip" -OutFile $ZipPath -UseBasicParsing

Write-Host "Entpacke install-tl.zip..."
Expand-Archive -Path $ZipPath -DestinationPath $ExtractDir -Force

$InstallTlDir = Get-ChildItem -Path $ExtractDir -Directory | Select-Object -First 1
if (-not $InstallTlDir) {
    throw "install-tl.zip enthielt kein Unterverzeichnis - Installation abgebrochen."
}

# TEXDIR & Co. mit Vorwaertsslashes, wie von install-tl erwartet.
$TexDirFwd = ($TexDir -replace '\\', '/')

$ProfileContent = @"
selected_scheme scheme-full
TEXDIR $TexDirFwd
TEXMFLOCAL $TexDirFwd/texmf-local
TEXMFSYSVAR $TexDirFwd/texmf-var
TEXMFSYSCONFIG $TexDirFwd/texmf-config
tlpdbopt_install_docfiles 0
tlpdbopt_install_srcfiles 0
instopt_adjustpath 0
instopt_desktop_integration 0
tlpdbopt_desktop_integration 0
tlpdbopt_file_assocs 0
"@
Set-Content -Path $ProfilePath -Value $ProfileContent -Encoding ASCII

$InstallBat = Join-Path $InstallTlDir.FullName 'install-tl-windows.bat'
if (-not (Test-Path $InstallBat)) {
    throw "install-tl-windows.bat nicht gefunden in $($InstallTlDir.FullName)"
}

Write-Host "Starte TeX-Live-Installation (Fenster bleibt sichtbar)..."
$proc = Start-Process -FilePath $InstallBat -ArgumentList @(
    '-no-gui',
    '-profile', "`"$ProfilePath`"",
    '-repository', "`"$Repo`""
) -NoNewWindow -PassThru -Wait

if ($proc.ExitCode -ne 0) {
    throw "install-tl-windows.bat ist mit Exit-Code $($proc.ExitCode) fehlgeschlagen."
}

if (-not (Test-Path $ExistingLatexmk)) {
    throw "Installation abgeschlossen, aber latexmk.exe wurde nicht unter $ExistingLatexmk gefunden."
}

Write-Host "TeX Live 2025 erfolgreich installiert: $TexDir"

# Aufraeumen
Remove-Item -Path $WorkDir -Recurse -Force -ErrorAction SilentlyContinue

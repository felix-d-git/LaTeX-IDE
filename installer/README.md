# LatexIDE Desktop Installer

## Build

```powershell
powershell -File installer\build-release.ps1
```

- `-StagingOnly`: nur Staging-Ordner zusammenstellen, kein npm ci/build/prune.
- `-WhatIf`: reiner Trockenlauf, nur zeigen was kopiert wuerde.

## Voraussetzungen

- Node.js + npm auf dem Build-Rechner (fuer `npm ci`, `node build.js`).
- Inno Setup 6 (fuer den Windows-Installer): https://jrsoftware.org/isdl.php
  - Erwartete Pfade: `%ProgramFiles(x86)%\Inno Setup 6\ISCC.exe` oder
    `%LOCALAPPDATA%\Programs\Inno Setup 6\ISCC.exe`.
  - Fehlt ISCC.exe, wird der Windows-Installer uebersprungen (nur Warnung,
    kein Abbruch); der macOS-ZIP wird trotzdem gebaut.

## Was der Build macht

1. Kopiert `client/` (ohne `client/dist`), `server/`, `package.json`,
   `package-lock.json`, `build.js` nach `installer\out\staging`.
2. Fuehrt dort `npm ci`, `node build.js`, `npm prune --omit=dev` aus.
3. Laedt Node.js 24 LTS (win-x64) von nodejs.org, prueft SHA256 gegen
   `SHASUMS256.txt`, kopiert es inkl. LICENSE nach `staging\node`.
4. Ruft `ISCC.exe` auf `installer\windows\LatexIDE.iss` auf ->
   `installer\out\LatexIDE-Setup.exe`.
5. Baut zusaetzlich `installer\out\LatexIDE-macOS.zip` (Staging ohne
   Windows-Node, dafuer mit `installer\macos\install.command`).

## Was der Windows-Installer tut

- Per-User-Installation ohne Admin-Rechte nach `%LOCALAPPDATA%\Programs\LatexIDE`.
- Start-Menu-Verknuepfung, optional Desktop-Verknuepfung, sauberer Uninstaller.
- Fuehrt nach dem Kopieren `install-texlive.ps1` aus (sichtbares Fenster).
- Uninstaller entfernt nur die App, laesst Datenordner und TeX Live stehen.

## Was der macOS-Installer tut

- `install.command` (aus dem ZIP entpackt, per Doppelklick startbar) laedt
  Node.js fuer die erkannte Architektur (arm64/x86_64), kopiert die App nach
  `~/Applications/LatexIDE/app`, installiert MacTeX falls noetig und legt
  `~/Applications/LatexIDE/LatexIDE.command` als Starter an.

## TeX Live / MacTeX Download-Groesse

- TeX Live `scheme-full` bzw. MacTeX: ca. 4-5 GB Download.
- Installation kann je nach Verbindung und Rechner mehrere Stunden dauern.
- Wird bei vorhandenem `latexmk` im PATH bzw. vorhandener Installation
  automatisch uebersprungen.

## Quellen fuer Downloads (fest verdrahtet)

- Node.js: `https://nodejs.org/dist/v<version>/`
- TeX Live 2025: `https://ftp.tu-chemnitz.de/pub/tug/historic/systems/texlive/2025/tlnet-final`
- MacTeX 2025: `https://ftp.tu-chemnitz.de/pub/tug/historic/systems/mactex/2025/`

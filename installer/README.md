# LaTeX-IDE Desktop Installer

## Build

```powershell
powershell -File installer\build-release.ps1
```

- `-StagingOnly`: nur Staging-Ordner zusammenstellen, kein npm ci/build/prune.
- `-WhatIf`: reiner Trockenlauf, nur zeigen was kopiert wuerde.

## Voraussetzungen

- Node.js + npm auf dem Build-Rechner (fuer `npm ci`, `node build.js`).
- Inno Setup 6 oder 7 (fuer den Windows-Installer): https://jrsoftware.org/isdl.php
  - Der GitHub-Runner `windows-latest` bringt derzeit Inno Setup 6 mit (fehlt
    es, installiert der Release-Workflow es per choco).
  - Gesucht wird `ISCC.exe` ueber die Umgebungsvariable `ISCC`, sonst unter
    `%ProgramFiles(x86)%`, `%ProgramFiles%` (nur 7) bzw. `%LOCALAPPDATA%\Programs`
    jeweils in `Inno Setup 7` bzw. `Inno Setup 6`.
  - Fehlt ISCC.exe, wird der Windows-Installer uebersprungen (nur Warnung,
    kein Abbruch); der macOS-ZIP wird trotzdem gebaut.

## Was der Build macht

1. Kopiert `client/` (ohne `client/dist`), `server/`, `package.json`,
   `package-lock.json`, `build.js`, `LICENSE`, `THIRD_PARTY_NOTICES.md`,
   `install-texlive.ps1` und die Windows-Starter (`LatexIDE.cmd`,
   `LatexIDE-Server.cmd`, `LatexIDE-Lokal.vbs`) nach `installer\out\staging`.
   `LICENSES-INSTALLER.txt` und `LICENSES-INSTALLER-en.txt` entstehen dort aus
   den Vorlagen (siehe unten), `{{TAG}}` wird zu `v<version>` aus `package.json`.
2. Fuehrt dort `npm ci`, `node build.js`, `npm prune --omit=dev --omit=optional`
   aus und loescht danach ungenutzte Teile von `pdfjs-dist` (`cmaps`,
   `standard_fonts`, `legacy`, `image_decoders`, `web`, `types`,
   `build/pdf.sandbox*`): pdf.js steckt gebuendelt in `client/dist`, der Server
   laedt es nicht.
3. Laedt Node.js 26 (win-x64) von nodejs.org, prueft SHA256 gegen
   `SHASUMS256.txt`, kopiert es inkl. LICENSE nach `staging\node` (fehlt die
   LICENSE, bricht der Build ab).
4. Ruft `ISCC.exe` auf `installer\windows\LatexIDE.iss` auf ->
   `installer\out\LatexIDE-Setup.exe`.
5. Baut zusaetzlich `installer\out\LatexIDE-macOS.zip` (Staging ohne
   Windows-Node, Windows-Starter, `install-texlive.ps1` und
   `LICENSES-INSTALLER-en.txt`, dafuer mit `installer\macos\install.command`).
   Dieses lokale ZIP traegt keine Unix-Rechte (`install.command` dann per
   `bash install.command` starten). Fuers Release legt der Workflow mit
   `-MacStagingOut` nur den Ordner ab; das ZIP packt ein Linux-Job mit
   `chmod +x install.command` und `zip -r -X`.

## Was der Windows-Installer tut

- Per-User-Installation ohne Admin-Rechte nach `%LOCALAPPDATA%\Programs\LatexIDE`.
- Zeigt `LICENSES-INSTALLER.txt` (englisch: `LICENSES-INSTALLER-en.txt`) als
  Hinweisseite (`InfoBeforeFile`), ohne Zustimmung - die AGPL verlangt keine.
- Loescht vor dem Kopieren `{app}\node_modules` (`[InstallDelete]`), damit bei
  Updates keine entfernten Pakete liegen bleiben. Nutzerdaten liegen dort nie.
- Start-Menu-Verknuepfung, optional Desktop-Verknuepfung, sauberer Uninstaller.
- Fuehrt nach dem Kopieren `install-texlive.ps1` aus (sichtbares Fenster).
- Uninstaller entfernt die App, TeX Live unter `%LOCALAPPDATA%\LatexIDE\texlive`
  und Caches; Projekte und Einstellungen nur nach Rueckfrage.

## Was der macOS-Installer tut

- `install.command` (aus dem ZIP entpackt, per Doppelklick startbar) laedt
  Node.js fuer die erkannte Architektur (arm64/x86_64), kopiert die App nach
  `~/Applications/LatexIDE/app`, installiert MacTeX falls noetig und legt
  `~/Applications/LatexIDE/LatexIDE.command` als Starter an.
- Vor dem MacTeX-Download gibt es einen Lizenzhinweis aus, weil
  `installer -pkg` die Lizenzseite des Pakets nicht zeigt.

## TeX Live / MacTeX Download-Groesse

- TeX Live `scheme-full` bzw. MacTeX: ca. 4-5 GB Download.
- Installation kann je nach Verbindung und Rechner mehrere Stunden dauern.
- Wird bei vorhandenem `latexmk` im PATH bzw. vorhandener Installation
  automatisch uebersprungen.

## Quellen fuer Downloads (fest verdrahtet)

- Node.js: `https://nodejs.org/dist/v<version>/`
- TeX Live 2025: `https://ftp.tu-chemnitz.de/pub/tug/historic/systems/texlive/2025/tlnet-final`
- MacTeX 2025: `https://ftp.tu-chemnitz.de/pub/tug/historic/systems/mactex/2025/`

## Lizenzhinweise im Paket

- `installer\LICENSES-INSTALLER.txt` (deutsch, Windows und macOS) und
  `installer\windows\LICENSES-INSTALLER-en.txt` (englisch, nur Windows-Setup)
  sind Vorlagen mit dem Platzhalter `{{TAG}}`. Bei Aenderungen beide anpassen
  und nur ASCII verwenden.
- Inno-Setup-Lizenz: Die Copyright- und Webseiten-Vermerke von Inno Setup
  (z. B. im Dialog "Ueber Setup") muessen im Setup erhalten bleiben. Eigene
  `[Messages]`-Eintraege oder `.isl`-Dateien duerfen sie nicht entfernen.

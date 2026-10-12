# LatexIDE — Arbeitsregeln

- Persönliches (Server, Pfade, Konten) steht in `CLAUDE.local.md` (gitignored).
- Branches: `master` = einziger Arbeitsbranch (Mehrbenutzer-Version seit 27.09.2026), Änderungen von Mitwirkenden per Pull Request; `legacy-local` = alte Einzelplatz-Version.
- TeX-Backend per `TEX_BACKEND` (`latexmk` Standard, `tectonic`): tectonic nur in der Desktop-App, `server/index.js` verweigert den Start damit (liest Dateien außerhalb des Projekts). TeX läuft nur als externer Prozess (Lizenz: AGPL-3.0-only + bloße Zusammenstellung).
- Installer bauen: `installer\build-release.ps1`; Inno Setup per `$env:ISCC` (auch portabel), Ausgabe `installer\out\` (gitignored).
- Desktop-App: `server/desktop.js` (Port 3178, `LATEX_IDE_DATA`), kompiliert lokal gegen einen Spiegel; Installer unter `installer/`. Server-Adresse aus `REMOTE_URL` → `server.json` im App-Ordner (kein Default; fehlt sie, beendet sich die App).
- Selbsthosten: `docker-compose.yml` (generisch, `TEXLIVE=apt` = Debian-texlive-full im Image) oder Windows-Installer-Option „Eigener Server" (`LatexIDE-Server.cmd`, `.env` im App-Ordner). Anleitung im README.
- 100 % lokal: `LOCAL_MODE=1` (Installer-Option 3, `LatexIDE-Lokal.vbs`): kein Login (alles als der eine Admin), nur `127.0.0.1` + Host-Prüfung gegen DNS-Rebinding, beendet sich `LOCAL_IDLE_MS` (30 s) nach dem letzten `/ws`-Client. Test: `LOCAL_NO_BROWSER=1`.
- Docker-Image: `.github/workflows/container-image.yml` baut + testet bei jedem Release, Push nach ghcr nur bei öffentlichem Repo (reguläres Release oder Dispatch auf master), mit pandoc; hängt vorher `DEBIAN-PACKAGES-<tag>.txt` + `pandoc-sources-<tag>.tar` (Debian-Quellen von pandoc + ghc + libghc-*-dev laut buildinfo per `scripts/pandoc-sources.py`, weil bookworm-pandoc kein Built-Using hat; GPL-Quellpflicht) ans Release.
- Desktop-Download: Server lädt die Assets des Releases `v<package.json-Version>` nach `DATA_DIR/desktop/<version>/` und baut beim Ausliefern seine URL ein (Setup.exe: 1024-Byte-Trailer, den `LatexIDE.iss` liest; macOS-Zip: angehängter `server.json`-Eintrag). Ohne passendes GitHub-Release kein Download.
- Lokale Kopie (Owner-Projekte): Ordner aus `LATEX_IDE_LOCAL` → Config (`localDir`, in den Einstellungen änderbar, verschiebt die Projekte) → `install.json` (vom Installer) → `~/Documents/LatexIDE`. Offline-Erkennung: Health-Ping alle 2 s, danach Circuit-Breaker (Anfragen sofort lokal). Tests immer mit `LATEX_IDE_LOCAL` auf Temp, sonst landet Testzeug in echten Dokumenten.
- Release: Version **nur** in `package.json` hochzählen + committen/pushen, dann GitHub-Release `vX.Y.Z` veröffentlichen → `.github/workflows/release.yml` baut `LatexIDE-Setup.exe` + `LatexIDE-macOS.zip` und hängt sie an (bricht ab, wenn Tag ≠ `package.json`). `LatexIDE.iss` bekommt die Version per `/DMyAppVersion`.
- Auto-Update Desktop (Windows + macOS, Popup): fragt den eigenen Server (`/api/desktop/release`, Download mit Desktop-Token) → App-Version folgt immer der Server-Version. Kein Token in den Paketen.
- Server-Update: Admin-Banner im Web-UI, Verhalten per `UPDATE_MODE` (`off`/`notify`/`button`/`auto`), Token für den Check `UPDATE_TOKEN` in `.env`. Installation immer durch `scripts/server-update.sh` auf dem Host (Backup, 3 behalten); `button` = App legt `.update-request` ab (in `VAULT_DIR`, wenn verschlüsselt, sonst `DATA_DIR`; Backup dann nur `vault/`), Cron mit `--if-requested`. Skript nimmt `docker-compose.yml`, auf dem Pi `COMPOSE=docker-compose.pi.yml` in `.update.env`.
- Verschlüsselung at-rest (ab 05.10.2026 auf dem Pi): mit `DATA_KEY` + `VAULT_DIR` liegen Nutzerdaten nur verschlüsselt in `VAULT_DIR`, `DATA_DIR` ist tmpfs im Container (`/app/data`, `LATEX_TMPFS`, zählt zu `mem_limit`). Start entschlüsselt alles, falscher Schlüssel = Abbruch. `DATA_KEY` steht nur in der Server-`.env` → ohne ihn sind Daten + Backups des Vaults unlesbar. Migration/CLI: `node server/lib/vault.js encrypt|keygen`.
- MCP: `POST /mcp` mit Bearer-Token (`lmcp_`, Einzelrechte read/comment/edit/create/delete/move/compile, pro Projekt einstellbar, in Einstellungen → MCP erzeugt/änderbar; compile standardmäßig aus; Reviewer im Projekt bekommen höchstens read+comment; Doku `docs/MCP.md`).
- Datenpfad per `DATA_DIR` (auth-data.json, .sessions, .session-secret, workspace.json, projects/, desktop/, mail-outbox.log); ohne = Repo-Wurzel. `SESSION_SECRET` optional, sonst einmalig erzeugt in `.session-secret`.
- Git-Remote: `origin` = https://github.com/felix-d-git/latex-web-ide (privat), Push/Releases nur auf Anweisung; Releases als Tag `vX.Y.Z` + GitHub-Release.
- Nie committen/pushen: `projects/` (private Arbeiten), `.env`, `auth-data.json`, `workspace.json` (alle in `.gitignore`).
- Start: `start.bat` (baut `client/dist` per `node build.js`, dann `node server/index.js`) → http://localhost:3077. Port per `PORT`-Env änderbar.
- Nach Änderungen in `client/src/` immer `node build.js`, sonst liefert der Server den alten Bundle aus.
- Braucht TeX Live 2025 (`latexmk`, `synctex`) im PATH.

## Tests gegen den laufenden Server
- „Aktives Projekt" liegt pro Benutzer global in `workspace.json`. Läuft eine echte Browsersitzung, nie auf 3077 Projekt wechseln oder kompilieren → Autosave schreibt sonst womöglich in den falschen Pfad.
- Stattdessen Wegwerf-Instanz: `client/`, `server/`, `package.json`, `build.js` nach `%LOCALAPPDATA%\Temp\latex-wegwerf\` kopieren, `node_modules` als Junction, pro Lauf frisches `DATA_DIR`, `PORT=3099`. Ohne `.env` greift der Fallback-Admin `admin` / `bitte-sofort-aendern`. Tests: `t_server.js` (API/Yjs), `t_desktop.js` (Desktop-Proxy), `t_browser.js` (Playwright, 2 Nutzer, Offline-Konflikt).
- Login-Limiter (10/15 min pro IP) schlägt bei wiederholten Testläufen zu → Wegwerf-Server neu starten.
- Aufräumen: **zuerst** die Junction per `cmd /c rmdir …\node_modules` entfernen, dann den Ordner löschen, sonst geht das echte `node_modules` mit.
- Playwright-Output (`.playwright-cli/`) nur im Temp-Ordner erzeugen (dort `cd`, dann `playwright-cli`).
- Farben in Agent-Screenshots wirken aufgehellt → Farbtreue nur per Pixel-Sampling (PIL) beurteilen.

## graphify
- `graphify query "<Begriff>"` sucht über Datei-/Funktionsnamen (keine DOM-IDs/Strings) → nach Modulnamen fragen, z. B. „menu bar" statt „home button".
- Git-Hook aktualisiert `graphify-out/` nach jedem Commit; manuell: `graphify update .`
- Nie `graphify install`/`graphify claude install` ausführen: schreibt nach `~\.claude` statt `CLAUDE_CONFIG_DIR`.

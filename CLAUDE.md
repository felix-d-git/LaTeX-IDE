# LaTeX Web IDE — Arbeitsregeln

- Betrieb (ab 25.09.2026, Mehrbenutzer): Server auf dem Pi in `~/container/latex` (Container `latex-collab` + `latex-tailscale`, Funnel `https://latex.example.org`), Deploy per `git archive` → `docker compose -f docker-compose.pi.yml up -d --build`. `.env` nur auf dem Pi. Daten `/srv/latex/data`, TeX Live 2025 read-only aus `/srv/latex/texlive` (Pfad im Container `/data/texlive` = Installationspfad, nicht ändern).
- Alte On-Demand-Installation (`~/container/latex-webide`, systemd `latex-ide-proxy.socket`, Port 3078) ist davon unabhängig.
- Desktop-App: `server/desktop.js` (Port 3178, `REMOTE_URL`, `LATEX_IDE_DATA`), kompiliert lokal gegen einen Spiegel; Installer unter `installer/`.
- Datenpfad per `DATA_DIR` (auth-data.json, .sessions, workspace.json, projects/, mail-outbox.log); ohne = Repo-Wurzel.
- Git-Remote: `origin` = https://github.com/felix-d-git/latex-web-ide (privat), Push/Releases nur auf Anweisung; Releases als Tag `vX.Y.Z` + GitHub-Release. Seit 25.09.2026 global nur noch `felix-d-git` (Credential Manager + `user.email` = GitHub-noreply-Adresse); das alte Konto `altes-konto` wird nicht mehr genutzt.
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
- Binary liegt nicht im PATH: `<lokaler Pfad>`
- `graphify query "<Begriff>"` sucht über Datei-/Funktionsnamen (keine DOM-IDs/Strings) → nach Modulnamen fragen, z. B. „menu bar" statt „home button".
- Git-Hook aktualisiert `graphify-out/` nach jedem Commit; manuell: `graphify update .`
- Nie `graphify install`/`graphify claude install` ausführen: schreibt nach `~\.claude` statt `CLAUDE_CONFIG_DIR`.

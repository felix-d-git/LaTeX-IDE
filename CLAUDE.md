# LaTeX Web IDE — Arbeitsregeln

- Betrieb **nur lokal** (Entscheidung 25.09.2026). Kein Deploy auf den Pi.
- Git-Remote: GitHub-Konto `felix-d-git` (Nutzervorgabe 25.09.2026), Push nur auf Anweisung. Seit 25.09.2026 global nur noch `felix-d-git` (Credential Manager + `user.email` = GitHub-noreply-Adresse); das alte Konto `altes-konto` wird nicht mehr genutzt.
- Nie committen/pushen: `projects/` (private Arbeiten), `.env`, `auth-data.json`, `workspace.json` (alle in `.gitignore`).
- Start: `start.bat` (baut `client/dist` per `node build.js`, dann `node server/index.js`) → http://localhost:3077. Port per `PORT`-Env änderbar.
- Nach Änderungen in `client/src/` immer `node build.js`, sonst liefert der Server den alten Bundle aus.
- Braucht TeX Live 2025 (`latexmk`, `synctex`) im PATH.

## Tests gegen den laufenden Server
- „Aktives Projekt" liegt pro Benutzer global in `workspace.json`. Läuft eine echte Browsersitzung, nie auf 3077 Projekt wechseln oder kompilieren → Autosave schreibt sonst womöglich in den falschen Pfad.
- Stattdessen Wegwerf-Instanz: `client/`, `server/`, `package.json`, `build.js` nach `%LOCALAPPDATA%\Temp\latex-wegwerf\` kopieren, leeres `projects/`, `node_modules` als Junction, `PORT=3099`. Ohne `.env` greift der Fallback-Admin `admin@local.host` / `bitte-sofort-aendern`.
- Aufräumen: **zuerst** die Junction per `cmd /c rmdir …\node_modules` entfernen, dann den Ordner löschen, sonst geht das echte `node_modules` mit.
- Playwright-Output (`.playwright-cli/`) nur im Temp-Ordner erzeugen (dort `cd`, dann `playwright-cli`).
- Farben in Agent-Screenshots wirken aufgehellt → Farbtreue nur per Pixel-Sampling (PIL) beurteilen.

## graphify
- Binary liegt nicht im PATH: `<lokaler Pfad>`
- `graphify query "<Begriff>"` sucht über Datei-/Funktionsnamen (keine DOM-IDs/Strings) → nach Modulnamen fragen, z. B. „menu bar" statt „home button".
- Git-Hook aktualisiert `graphify-out/` nach jedem Commit; manuell: `graphify update .`
- Nie `graphify install`/`graphify claude install` ausführen: schreibt nach `~\.claude` statt `CLAUDE_CONFIG_DIR`.

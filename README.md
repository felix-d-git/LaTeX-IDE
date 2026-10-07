# LaTeX Web IDE

Overleaf-artige LaTeX-Umgebung zum Selbsthosten: Mehrbenutzer-Server mit
Weboberfläche und Desktop-App (Windows/macOS) mit lokaler Kopie und
Offline-Kompilieren. Kompiliert mit einer echten TeX-Live-Installation
(`latexmk`) statt eines Cloud-Compilers.

## Installation

Jeder kann einen eigenen LatexIDE-Server betreiben. Der Server liefert die
Weboberfläche aus und bietet nach der Anmeldung die Desktop-App zum Download an
(Profil → „Desktop-App herunterladen") – mit der Adresse dieses Servers schon
eingebaut. Desktop-Apps holen ihre Updates von ihrem Server, der Server holt sie
aus den GitHub-Releases.

Drei Wege, den Server zu betreiben:

| Weg | Für | TeX Live |
|---|---|---|
| Docker unter Linux | Heimserver, VPS, Raspberry Pi | im Image (Debian) oder eigenes einhängen |
| Docker Desktop unter Windows/macOS | Rechner, der ohnehin läuft | im Image (Debian) |
| Windows-Installer, Option „Eigener Server" | ein einzelner Windows-PC, ohne Docker | TeX Live 2025, lädt der Installer |

### Docker unter Linux

Voraussetzungen: Docker mit Compose-Plugin (`docker compose version`), git, ~8 GB
freier Speicher (TeX Live im Image ist ~5 GB).

```bash
git clone https://github.com/felix-d-git/latex-web-ide.git
cd latex-web-ide
git checkout "$(git describe --tags --abbrev=0)"   # neuestes Release statt Entwicklungsstand
cp .env.example .env
nano .env                                          # PUBLIC_URL, ADMIN_EMAIL, ADMIN_PASSWORD
mkdir -p data                                      # vorher anlegen, sonst gehört er root
docker compose up -d --build                       # erster Build dauert (TeX Live)
```

Danach unter `http://<server>:3077` mit `ADMIN_EMAIL` / `ADMIN_PASSWORD`
anmelden. Weitere Konten entstehen über Einladungslinks (Profil → Einladungen).

- **Von außen erreichbar machen:** Reverse Proxy mit HTTPS (Caddy, nginx,
  Traefik, Tailscale Funnel …) auf Port 3077, Websockets durchreichen. Dann in
  `.env` `PUBLIC_URL=https://…` und `COOKIE_SECURE=true` setzen und
  `docker compose up -d` erneut ausführen. `PUBLIC_URL` ist auch die Adresse,
  die in die heruntergeladene Desktop-App eingebaut wird.
- **Daten** liegen in `./data` (Konten, Projekte, Sitzungen). Diesen Ordner sichern.
- **Eigenes TeX Live statt Debian-Paket** (aktueller als TeX Live 2022 aus
  Debian, oder auf einer anderen Platte): TeX Live 2025 nach `/data/texlive`
  installieren (bzw. dort hin einhängen), in `.env` `TEXLIVE=host` setzen und in
  `docker-compose.override.yml` einhängen:

  ```yaml
  services:
    app:
      volumes:
        - /pfad/zu/texlive:/data/texlive:ro
  ```

- **Eigene Anpassungen** (anderer Port, Speicherlimit, Proxy-Netz) gehören in
  `docker-compose.override.yml` – die Datei wird von Updates nicht angefasst.

### Docker Desktop unter Windows (oder macOS)

1. [Docker Desktop](https://www.docker.com/products/docker-desktop/) installieren
   (unter Windows mit WSL 2) und starten.
2. Release-Quellcode herunterladen: GitHub → Releases → neuestes Release →
   „Source code (zip)", entpacken (oder per `git clone` wie oben).
3. Im entpackten Ordner `.env.example` nach `.env` kopieren und ausfüllen,
   Ordner `data` anlegen.
4. Im Ordner ein Terminal öffnen (PowerShell) und `docker compose up -d --build`
   ausführen.
5. `http://localhost:3077` öffnen.

Docker Desktop startet den Container nach einem Neustart automatisch wieder,
sofern „Start Docker Desktop when you sign in" aktiv ist.

### Windows ohne Docker (Installer)

1. GitHub → Releases → neuestes Release → `LatexIDE-Setup.exe` herunterladen.
2. Setup starten, Betriebsart **„Eigener Server auf diesem Rechner"** wählen,
   Admin-E-Mail und -Passwort festlegen.
3. Der Installer bringt Node mit und installiert TeX Live 2025 (kann je nach
   Leitung mehrere Stunden dauern).
4. Start über das Startmenü („LatexIDE") → öffnet `http://localhost:3077`.

Einstellungen stehen danach in `%LOCALAPPDATA%\Programs\LatexIDE\.env`, die Daten
in `%LOCALAPPDATA%\LatexIDE\server-data`. Andere Rechner im Netz erreichen den
Server unter `http://<rechnername>:3077` (Windows-Firewall freigeben; dann
`PUBLIC_URL` in `.env` setzen). Update: neues Setup aus dem Release darüber
installieren – `.env` und Daten bleiben erhalten.

### Desktop-App

Nach der Anmeldung in der Weboberfläche: Profil → „Desktop-App herunterladen"
(Windows oder macOS). Das Paket kennt die Server-Adresse bereits; beim ersten
Start meldet man sich einmal im Browser an. Die App hält eine lokale Kopie der
eigenen Projekte und kompiliert lokal (TeX Live installiert der
Windows-Installer bzw. `install.command` unter macOS).

Ein Setup direkt aus den GitHub-Releases fragt stattdessen nach der
Server-Adresse.

### Updates

- **Server:** Admins sehen ein Banner, sobald es ein neues Release gibt.
  Verhalten per `UPDATE_MODE` in `.env`:
  `notify` (Standard, nur Hinweis) · `button` (Admin stößt das Update im
  Web-UI an) · `auto` (nachts) · `off`.
  Installiert wird immer durch `scripts/server-update.sh` auf dem Host: Backup
  von `data/` (die letzten 3 bleiben), neues Release entpacken, Container neu
  bauen. Cron-Zeilen (`crontab -e`):

  ```
  # auto:
  17 4 * * * /pfad/zu/latex-web-ide/scripts/server-update.sh >> $HOME/latex-update.log 2>&1
  # button:
  */5 * * * * /pfad/zu/latex-web-ide/scripts/server-update.sh --if-requested >> $HOME/latex-update.log 2>&1
  ```

  Bei `notify` das Skript von Hand starten. Unter Windows mit Docker Desktop
  läuft es in Git Bash oder WSL. Zusätzliche Einstellungen für das Skript
  (`COMPOSE`, `BACKUP_DIR`, `GITHUB_TOKEN`) in `.update.env` im Repo-Ordner.
- **Desktop-Apps** fragen ihren Server und bieten ein Update an, sobald der
  Server auf einer neueren Version läuft.
- Solange das GitHub-Repo privat ist, braucht der Server einen Lese-Token
  (`UPDATE_TOKEN` in `.env`, `GITHUB_TOKEN` in `.update.env`).

### Optionale Dienste (`.env`)

- `LANGUAGETOOL_URL` — eigener [LanguageTool](https://languagetool.org)-Server
  (LGPL, z. B. Docker-Image `erikvl87/languagetool`), etwa
  `http://languagetool:8010`. Dann bietet Einstellungen ▸ Spelling die
  Grammatikprüfung an; ohne Eintrag ist sie aus. Texte gehen nur an diesen
  Server.
- LanguageTool auf dem eigenen Rechner: Einstellungen ▸ Spelling ▸
  „LanguageTool-URL (eigener Rechner)“, z. B. `http://localhost:8081`. Der
  Browser (Web-UI und Desktop-App) fragt dann `<URL>/v2/check` direkt an, der
  Server wird nicht gebraucht. LanguageTool muss dafür mit `--allow-origin '*'`
  laufen, z. B. `java -cp languagetool-server.jar
  org.languagetool.server.HTTPServer --port 8081 --allow-origin '*'`. Leer =
  Server-LanguageTool.
- `PANDOC` — Pfad zu Pandoc (GPL, läuft als externer Prozess) für
  File ▸ Download ▸ Markdown/HTML. Im Docker-Image enthalten; ohne Pandoc
  meldet der Export einen Fehler.
- Literatur: Zotero (API-Key pro Nutzer, Einstellungen ▸ References), DOI über
  doi.org, `.bib` per Upload oder URL. Der Server braucht dafür Internetzugang.

### Verschluesselte Daten (optional)

Mit `DATA_KEY` (32 Byte, hex/base64; `node server/lib/vault.js keygen`) und `VAULT_DIR`
liegen alle Nutzerdaten nur verschluesselt (AES-256-GCM, Dateinamen als HMAC) in `VAULT_DIR`.
`DATA_DIR` ist dann ein fluechtiges Arbeitsverzeichnis (z. B. tmpfs): der Server entschluesselt
beim Start dorthin und spiegelt Aenderungen entprellt zurueck. Falscher Schluessel = Start
bricht ab. Bestehende Daten einmalig uebernehmen:
`DATA_KEY=… VAULT_DIR=… node server/lib/vault.js encrypt <alter-Datenordner>` (Klartext bleibt, danach selbst loeschen).
Nicht gespiegelt: Build-Ausgaben, `desktop/`, `texlive`. Ohne Schluessel kein Zugriff: Schluessel separat sichern.

### Entwicklung (ohne Docker)

```
start.bat        (Windows)
./start.sh       (Linux/macOS)
```

Braucht Node 24 und TeX Live (`latexmk`, `synctex`) im `PATH`; öffnet
`http://localhost:3077`.

## Funktionen

- Dateibaum (links), Editor mit Tabs (Mitte, CodeMirror 6 + LaTeX-Highlighting),
  PDF-Vorschau (rechts, PDF.js)
- Live-Sync beim Tippen (Yjs), Speichern auf Platte nach 0,5 s
- Kompilieren-Button → ruft `latexmk -pdf` im Projektordner auf, Log-Panel
  unten zeigt Fehler/Warnungen
- Haupt-Datei umschaltbar (Doppelklick auf eine `.tex`-Datei im Baum)
- **Projektweite Suche & Ersetzen** (Strg+Shift+F oder Button oben): Suche
  über alle Textdateien, mit Regex/Groß-Klein/Ganzes-Wort-Optionen, "Alle
  ersetzen" schreibt direkt in die Dateien auf der Festplatte
- **Strg+F** in der aktiven Datei: eingebaute CodeMirror-Suche/Ersetzung
- **Live-Sync bei externen Änderungen**: Ein Dateisystem-Watcher erkennt
  Änderungen, die *nicht* über die eigene Speicherfunktion erfolgt sind (z.B.
  wenn Claude Code direkt Dateien im Projektordner bearbeitet), lädt den
  neuen Inhalt automatisch nach und markiert die geänderten Zeilen kurz gelb
  im Editor.

## Accounts / Login

Kein offenes Registrierungsformular - neue Konten entstehen ausschließlich
über einen Einladungslink, den der Admin im Einstellungen-Dialog (⚙️ → Account)
erzeugt und manuell verschickt (WhatsApp/Mail/…). Details:

- **Erster Start:** `.env` aus `.env.example` kopieren, `ADMIN_EMAIL`/
  `ADMIN_PASSWORD` setzen (ohne `.env` wird ein Fallback-Admin
  `admin@local.host` / `bitte-sofort-aendern` angelegt - Passwort direkt danach über
  "Passwort vergessen" ändern). Der Sitzungs-Schlüssel wird beim ersten Start
  erzeugt und im Datenordner (`.session-secret`) gespeichert.
- **Projekt-Isolation:** Der Admin behält den bestehenden `projects/`-Ordner
  unverändert. Jeder eingeladene Nutzer bekommt
  eine eigene, isolierte Projektsammlung unter `projects/users/<id>/` - Konten
  sehen sich gegenseitig nicht.
- **Passwort vergessen:** Reset-Link läuft über `/api/auth/forgot-password`.
  Ohne SMTP-Konfiguration (`SMTP_HOST` etc. in `.env`) wird der Link nur in
  der Konsole und in `mail-outbox.log` ausgegeben (lokaler Testbetrieb) -
  sobald SMTP gesetzt ist, wird tatsächlich gemailt.
- **Angemeldet bleiben:** Normale Session-Cookie (Datei-Store, überlebt
  Neustarts), Checkbox beim Login steuert nur die Cookie-Lebensdauer (Browser-
  Sitzung vs. 30 Tage).
- **CSRF-Schutz:** Double-Submit-Cookie-Pattern für alle verändernden
  Requests, zusätzlich `SameSite=Lax`-Cookies.
- **Bekannte Windows-Eigenheit:** Der dateibasierte Session-Store
  (`session-file-store`) kann bei sehr schnell aufeinanderfolgenden
  Requests vereinzelt einen `EPERM`-Rename-Fehler in die Konsole schreiben
  (Windows-Dateisystem-Race beim atomaren Schreiben). Das ist unschädlich -
  die Session bleibt gültig, nur die Ablauf-Verlängerung dieses einen
  Requests greift nicht. Kein Absturz, kein Datenverlust.
- **Noch nicht umgesetzt (bewusst zurückgestellt):** Google-/OAuth-Login -
  siehe "Bekannte Grenzen" unten.

## KI/MCP

Externe KI-Tools (Claude Desktop/Code, Cursor) arbeiten mit ihrem eigenen Abo an deinen Projekten – die IDE ist dafür ein MCP-Server (`POST /mcp`, Streamable HTTP, zustandslos).

1. Einstellungen → Reiter „MCP“: Name, Einzelrechte und Projekte wählen → „Token erstellen“. Der Token (`lmcp_…`) wird nur einmal angezeigt, der Server speichert nur den Hash. Rechte und Projektauswahl lassen sich dort später ändern, ohne neuen Token; Widerrufen ebenfalls.
2. Einzelrechte: `read`, `comment`, `edit`, `create`, `delete`, `move`, `compile` (standardmäßig aus – Kompilieren ist langsam und belastet den Server). Pro Projekt einstellbar. Nie mehr als dein eigener Zugriff; als Reviewer höchstens `read` + `comment`. Details: [docs/MCP.md](docs/MCP.md).
3. Claude Code: `claude mcp add --transport http latex https://<server>/mcp --header "Authorization: Bearer <token>"`
4. Claude Desktop / Cursor (Konfigurationsdatei, ggf. über `npx mcp-remote`):
   ```json
   { "mcpServers": { "latex": { "command": "npx", "args": ["-y", "mcp-remote", "https://<server>/mcp", "--header", "Authorization: Bearer <token>"] } } }
   ```

Werkzeuge je Recht: `read`: `list_projects`, `project_tree`, `outline`, `read_file` (max. 400 Zeilen), `search`, `get_errors`; `comment`: `add_comment`, `suggest_change`; `edit`: `edit_file`; `create`: `create_file` (Text oder base64); `delete`: `delete_file`; `move`: `move_file`; `compile`: `compile` (startet asynchron) + `compile_status`. Änderungen laufen über das Yjs-Dokument bzw. den Datei-Watcher, offene Editoren sehen sie live.

## Architektur

```
server/   Express + WebSocket-Server, Datei-API, Compile-API (latexmk),
          Suche/Ersetzen, chokidar-Watcher mit Echo-Unterdrückung
client/   Vanilla-JS-Frontend (CodeMirror 6, PDF.js), gebündelt mit esbuild
projects/ lokale Testprojekte (nicht Teil des eigentlichen Tools)
```

Kein Framework-Overhead, keine Cloud-Abhängigkeit — bewusst so gehalten,
damit sich das Ganze später 1:1 auf den Raspberry Pi oder einen anderen
Rechner kopieren lässt (Node.js ist plattformunabhängig; einzige externe
Voraussetzung ist eine installierte TeX-Distribution im `PATH` der
Zielmaschine).

## Bekannte Grenzen (MVP, Stand jetzt)

- SyncTeX (Klick im PDF → Sprung zur Tex-Zeile) ist noch nicht implementiert.
- Bilddateien werden im Baum angezeigt, aber nicht in einem Bild-Viewer
  geöffnet (nur Text-Dateien sind editierbar).
- **Google-Login:** bewusst zurückgestellt, bis der Raspberry-Pi-Deploy mit
  Portweiterleitung/echter Domain steht - Google OAuth verlangt eine
  öffentlich erreichbare HTTPS-Redirect-URI, die auf reinem `localhost` nicht
  funktioniert. Vermerkt für später, siehe STATUS.md.

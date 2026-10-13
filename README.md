# LatexIDE

Selbst gehostete LaTeX-Web-IDE mit Live-Zusammenarbeit: Mehrbenutzer-Server mit
Weboberfläche und Desktop-App (Windows/macOS) mit lokaler Kopie und
Offline-Kompilieren. Kompiliert mit einer echten TeX-Live-Installation
(`latexmk`) statt eines Cloud-Compilers.

## Installation

Jeder kann einen eigenen LatexIDE-Server betreiben. Der Server liefert die
Weboberfläche aus und bietet nach der Anmeldung die Desktop-App zum Download an
(Profil → „Desktop-App herunterladen") – mit der Adresse dieses Servers schon
eingebaut. Desktop-Apps holen ihre Updates von ihrem Server, der Server holt sie
aus den GitHub-Releases.

### Welche Datei brauche ich?

Alles liegt unter [Releases](https://github.com/felix-d-git/latex-web-ide/releases/latest).

| Ich will … | Datei | Voraussetzungen | Updates | Anleitung |
|---|---|---|---|---|
| einen **Server** für mehrere Konten (Linux, Raspberry Pi, Docker Desktop) | Source code bzw. `git clone`, dann `docker compose up -d --build` | Docker, 2 GB RAM (besser 4), ~8 GB Platte | Skript auf dem Host: Hinweis, Button im Web-UI oder nachts | [docs/INSTALL-DOCKER.md](docs/INSTALL-DOCKER.md) |
| einen **Server auf einem Windows-PC** ohne Docker | `LatexIDE-Setup.exe` → „Eigener Server auf diesem Rechner“ | Windows 10/11, ~8 GB | neues Setup drüber | [docs/INSTALL-WINDOWS.md](docs/INSTALL-WINDOWS.md) |
| die **Desktop-App** für einen bestehenden Server (offline arbeiten, lokal kompilieren) | aus der Weboberfläche (Profil → „Desktop-App herunterladen“), sonst `LatexIDE-Setup.exe` / `LatexIDE-macOS.zip` | Konto auf einem Server, Windows oder macOS, ~6 GB | automatisch über den eigenen Server | [docs/DESKTOP-APP.md](docs/DESKTOP-APP.md) |
| **100 % lokal** an einem Windows-Rechner, ohne Server und Konto | `LatexIDE-Setup.exe` → „Nur dieser Rechner (100 % lokal, ohne Konto)“ | Windows 10/11, ~8 GB | neues Setup drüber | [docs/INSTALL-WINDOWS.md](docs/INSTALL-WINDOWS.md#100--lokal-betrieb) |

- `LatexIDE-Setup.exe` enthält alle drei Windows-Varianten; das Setup fragt nach
  der Betriebsart. Die Dateinamen bleiben über alle Versionen gleich (Server und
  Desktop-Apps laden sie unter diesem Namen).
- Setup und macOS-Paket installieren TeX Live 2025 bzw. MacTeX (~5 GB), falls
  noch keines da ist. Das Docker-Image bringt TeX Live 2022 aus Debian mit oder
  hängt ein eigenes ein.
- Updates aller Varianten: [docs/UPDATES.md](docs/UPDATES.md).

### Öffentliches oder privates Repository

Alle Anleitungen funktionieren mit beidem. Solange das Repository privat ist:

- Herunterladen nur mit GitHub-Zugang zum Repository (`git clone` per SSH-Schlüssel
  oder Token).
- Der Server braucht einen Lese-Token (fine-grained, nur „Contents: Read-only“)
  für Update-Hinweis und Desktop-Downloads: `UPDATE_TOKEN` in `.env`,
  `GITHUB_TOKEN` in `.update.env` → [docs/UPDATES.md](docs/UPDATES.md#privates-repository).
- Ein fertiges Docker-Image (`ghcr.io`) gibt es erst bei öffentlichem Repository.

Ist das Repository öffentlich, entfallen Tokens und Zugang; vorhandene Tokens
können dann gelöscht werden.

### Optionale Dienste (`.env`)

- `LANGUAGETOOL_URL` — eigener [LanguageTool](https://languagetool.org)-Server
  (LGPL, z. B. das inoffizielle Docker-Image `erikvl87/languagetool`), etwa
  `http://languagetool:8010`. Dann bietet Einstellungen ▸ Spelling die
  Grammatikprüfung an; ohne Eintrag ist sie aus. Texte gehen nur an diesen
  Server. Die öffentliche API `api.languagetool.org` ist dafür ungeeignet und
  nicht voreingestellt: Ihre
  [Bedingungen](https://dev.languagetool.org/public-http-api) (Stand
  Oktober 2026) erlauben höchstens 20 KB Text pro Anfrage, untersagen
  automatisierte Anfragen und verlangen einen sichtbaren Link auf
  LanguageTool; die Texte gingen zudem an die LanguageTooler GmbH. Aktuelle
  Grenzen dort prüfen.
- LanguageTool auf dem eigenen Rechner: Einstellungen ▸ Spelling ▸
  „LanguageTool-URL (eigener Rechner)“, z. B. `http://localhost:8081`. Der
  Browser (Web-UI und Desktop-App) fragt dann `<URL>/v2/check` direkt an, der
  Server wird nicht gebraucht. LanguageTool muss dafür mit `--allow-origin '*'`
  laufen, z. B. `java -cp languagetool-server.jar
  org.languagetool.server.HTTPServer --port 8081 --allow-origin '*'`. Leer =
  Server-LanguageTool.
- `PANDOC` — Pfad zu Pandoc (GPL, läuft als externer Prozess) für
  File ▸ Download ▸ Markdown/HTML. Im selbst gebauten Docker-Image enthalten,
  nicht im fertigen Image von ghcr.io
  ([docs/INSTALL-DOCKER.md](docs/INSTALL-DOCKER.md#fertiges-image-nur-bei-öffentlichem-repository));
  ohne Pandoc meldet der Export einen Fehler. Benötigt Pandoc ≥ 2.15 (Ubuntu
  20.04/Debian 11 liefern ältere Versionen, dann Pandoc von pandoc.org installieren).
- `COMPILE_TIMEOUT_MS` — Zeitlimit pro Kompiliervorgang (Standard `600000`
  = 10 min). Danach beendet der Server latexmk samt pdflatex/biber und meldet
  „Zeitlimit überschritten“, etwa bei einer Endlosschleife im Dokument; die
  Warteschlange für alle anderen Nutzer läuft weiter.
- Literatur: Zotero (API-Key pro Nutzer, Einstellungen ▸ References), DOI über
  doi.org, `.bib` per Upload oder URL. Der Server braucht dafür Internetzugang.
  Der Zotero-API-Key wird auf dem Server gespeichert (`auth-data.json` im
  Datenordner) und nur für Abrufe bei `api.zotero.org` verwendet; beim Anlegen
  nur Lesezugriff erteilen.

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

- Bilddateien werden im Baum angezeigt, aber nicht in einem Bild-Viewer
  geöffnet (nur Text-Dateien sind editierbar).
- **Google-Login:** bewusst zurückgestellt, bis der Raspberry-Pi-Deploy mit
  Portweiterleitung/echter Domain steht - Google OAuth verlangt eine
  öffentlich erreichbare HTTPS-Redirect-URI, die auf reinem `localhost` nicht
  funktioniert.

## Lizenz

Copyright (C) 2026 felix-d-git

Freie Software unter der GNU Affero General Public License, ausschließlich
Version 3 (`AGPL-3.0-only`), siehe [LICENSE](LICENSE). Sie wird OHNE JEDE
GEWÄHRLEISTUNG bereitgestellt (Abschnitte 15 und 16 der Lizenz). Das gilt für
alle Versionen, Tags und Commits dieses Repositorys, auch für die vor Einführung
der Datei `LICENSE` (u. a. `v0.1.0` und `legacy-local`).

- Drittkomponenten und ihre Lizenzen:
  [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md), im laufenden Programm unter
  `/licenses` (Help ▸ Licenses). Software im Docker-Image:
  [docs/INSTALL-DOCKER.md](docs/INSTALL-DOCKER.md#drittsoftware-im-docker-image).
- Quellcode: Jede Instanz verweist unter `/source` (Help ▸ Source code) auf
  ihren Quellcode, standardmäßig auf den Tag ihrer Version in diesem
  Repository. Wer eine veränderte Fassung betreibt oder weitergibt, setzt
  `SOURCE_URL` auf den eigenen Quellcode (AGPL Abschnitt 13 bzw. 6, siehe
  `.env.example`).
- Beiträge: [CONTRIBUTING.md](CONTRIBUTING.md).

## Marken

Overleaf ist eine Marke der Digital Science UK Limited. Dieses Projekt ist eine
unabhängige Eigenentwicklung, kein Fork von Overleaf, und steht in keiner
Verbindung zu Overleaf oder Digital Science. Zotero ist eine eingetragene Marke
der Corporation for Digital Scholarship; die IDE greift nur über die
Zotero-Web-API auf Bibliotheken zu und steht in keiner Verbindung zur
Corporation for Digital Scholarship. Weitere genannte Namen können Marken
ihrer jeweiligen Inhaber sein.

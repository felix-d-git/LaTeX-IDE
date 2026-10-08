# Updates

Zurück zur [Übersicht](../README.md#installation)

| Variante | Wie |
|---|---|
| Docker-Server | `scripts/server-update.sh` auf dem Host, je nach `UPDATE_MODE` von Hand, per Button im Web-UI oder nachts (unten) |
| Windows-Server / 100 % lokal | neues `LatexIDE-Setup.exe` drüber installieren ([INSTALL-WINDOWS.md](INSTALL-WINDOWS.md#updates)) |
| Desktop-App | bietet das Update selbst an, sobald ihr Server neuer ist ([DESKTOP-APP.md](DESKTOP-APP.md#updates)) |

## Docker-Server

Admins sehen im Web-UI ein Banner, sobald es auf GitHub ein neueres Release
gibt (Prüfung alle 6 Stunden). Was dann passiert, legt `UPDATE_MODE` in `.env` fest:

| `UPDATE_MODE` | Verhalten | Cron-Zeile (`crontab -e`) |
|---|---|---|
| `notify` (Standard) | nur Banner; Update von Hand: `scripts/server-update.sh` | – |
| `button` | Banner mit „Jetzt aktualisieren“; das Update startet innerhalb einer Minute, das Banner zeigt Fortschritt und Ergebnis | `* * * * * /pfad/zu/latex-web-ide/scripts/server-update.sh --if-requested >> $HOME/latex-update.log 2>&1` |
| `auto` | nachts automatisch | `17 4 * * * /pfad/zu/latex-web-ide/scripts/server-update.sh >> $HOME/latex-update.log 2>&1` |
| `off` | kein Banner, keine Prüfung | – |

Nach einer Änderung an `UPDATE_MODE`: `docker compose up -d` (bzw. mit `-f docker-compose.pi.yml`).

### Was das Skript tut

1. Prüft das neueste Release auf GitHub und vergleicht es mit dem installierten
   (`.release` im Repo-Ordner; fehlt die Datei, gilt jedes Release als neu).
2. Sichert den Datenordner nach `BACKUP_DIR` (mit Verschlüsselung nur `vault/`).
   Die letzten 3 Backups bleiben.
3. Lädt den Quellstand des Releases, kopiert ihn über den Repo-Ordner und löscht
   Dateien, die es im neuen Release nicht mehr gibt (`.env`, `.update.env`,
   `docker-compose.override.yml` und Daten bleiben unangetastet).
4. Baut den Container neu und startet ihn (`docker compose up -d --build`).

Es läuft immer nur ein Update gleichzeitig. Den Fortschritt schreibt das Skript
nach `.update-status` im Datenordner; daraus liest das Banner. Schlägt etwas fehl,
zeigt das Banner die letzten Zeilen des Protokolls und „Erneut versuchen“; das
vollständige Protokoll steht in `latex-update.log`.

Die Daten sind dabei nicht in Gefahr: der laufende Container bleibt bis zum
erfolgreichen Neubau aktiv, und das Backup liegt vorher bereit.

### Einstellungen für das Skript (`.update.env` im Repo-Ordner)

```bash
COMPOSE=docker-compose.pi.yml   # andere Compose-Datei (Standard docker-compose.yml)
BACKUP_DIR=$HOME/latex-backups  # Standard: neben dem Datenordner, ./backups
# DATA_DIR=...                  # Standard: LATEX_DATA_DIR aus .env, sonst ./data
# GITHUB_TOKEN=...              # nur bei privatem Repo, siehe unten
```

Das Skript muss die Daten lesen und `docker` aufrufen dürfen: entweder als
Nutzer in der Gruppe `docker`, dem der Datenordner gehört, oder per `sudo crontab -e`.
Unter Windows mit Docker Desktop läuft es in Git Bash oder WSL (ohne Cron von Hand).

### Zurück auf ein Backup

```bash
docker compose down
tar -xzf <BACKUP_DIR>/data-<datum>-<version>.tar.gz -C <Elternordner des Datenordners>
# mit Verschlüsselung: -C <LATEX_DATA_DIR> (das Archiv enthält vault/)
git -C /pfad/zu/latex-web-ide checkout <alte Version>   # oder alten Quellstand entpacken
docker compose up -d --build
```

## Öffentliches oder privates Repository

**Öffentlich:** nichts weiter nötig. Server, Update-Skript und Desktop-Downloads
greifen ohne Anmeldung auf die GitHub-Releases zu.

<a id="privates-repository"></a>
**Privat:** GitHub antwortet ohne Anmeldung mit 404. Dann braucht der Server
einen Lese-Token:

1. GitHub → Settings → Developer settings → Fine-grained tokens → „Generate new token“.
2. Repository access: „Only select repositories“ → `latex-web-ide`.
3. Permissions → Repository permissions → **Contents: Read-only** (sonst nichts).
4. Token eintragen:
   - `.env`: `UPDATE_TOKEN=github_pat_…` → Banner und Desktop-Downloads (danach `docker compose up -d`)
   - `.update.env`: `GITHUB_TOKEN=github_pat_…` → Update-Skript
   - `chmod 600 .env .update.env`

Fine-grained Tokens laufen ab (max. 1 Jahr) → rechtzeitig erneuern. Sobald das
Repository öffentlich ist, beide Einträge löschen.

Ohne Token: Banner zeigt keine Updates (Fehler „GitHub HTTP 404“ nur im
API-Ergebnis), die Desktop-Downloads im Profil melden „kein Installationspaket
verfügbar“, und das Skript bricht mit „Repo privat ohne GITHUB_TOKEN“ ab.

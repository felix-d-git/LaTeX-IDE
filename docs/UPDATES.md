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
| `button` | Banner mit „Jetzt aktualisieren“; das Update startet innerhalb einer Minute, das Banner zeigt Fortschritt und Ergebnis | `* * * * * /pfad/zu/LaTeX-IDE/scripts/server-update.sh --if-requested >> $HOME/latex-update.log 2>&1` |
| `auto` | nachts automatisch | `17 4 * * * /pfad/zu/LaTeX-IDE/scripts/server-update.sh >> $HOME/latex-update.log 2>&1` |
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

### Signierte Releases (Pflicht)

Das Skript installiert nur Tags, die per `git verify-tag` gegen die Datei `.release-signers`
im Repo-Ordner des Hosts geprüft werden. Die Datei kommt nie aus dem Repo und wird nie vom
Update überschrieben. Fehlt sie oder stimmt die Signatur nicht, bricht das Update ab.

1. Schlüssel erzeugen (einmalig, nicht auf dem Server): `ssh-keygen -t ed25519 -N "" -f release_key`
2. Privaten Schlüssel als Actions-Secret `RELEASE_SIGNING_KEY` setzen (Repo, Settings, Secrets and variables, Actions). Fehlt es, scheitert `auto-release.yml` mit Fehler. Danach `release_key` lokal löschen. Manuelle Release-Tags mit `git -c gpg.format=ssh -c user.signingkey=<Schlüssel> tag -s vX.Y.Z -m vX.Y.Z` signieren.
3. Auf dem Host `.release-signers` anlegen (`chmod 600`), eine Zeile pro erlaubtem Schlüssel:
   `echo "release-signer $(cat release_key.pub)" > .release-signers`
   (Format siehe `ssh-keygen(1)`, ALLOWED SIGNERS).

Zusätzlich stoppt das Update, wenn sich `docker-compose*`, `Dockerfile` oder `scripts/server-update.sh`
gegenüber dem installierten Stand ändern. Nach Prüfung des Diffs mit `ALLOW_INFRA_CHANGES=1` (in `.update.env`
oder in der Umgebung) erneut starten und danach wieder entfernen. Die Wartezeit vor dem Auto-Release
(`MIN_AGE_H`, #177) bleibt unverändert.

Empfohlen, Repo-Einstellung: "Immutable releases" aktivieren (Settings, General), damit veröffentlichte
Tags/Assets nicht nachträglich geändert werden können.

### Einstellungen für das Skript (`.update.env` im Repo-Ordner)

```bash
COMPOSE=docker-compose.pi.yml   # andere Compose-Datei (Standard docker-compose.yml)
BACKUP_DIR=$HOME/latex-backups  # Standard: neben dem Datenordner, ./backups
# DATA_DIR=...                  # Standard: LATEX_DATA_DIR aus .env, sonst ./data
# VAULT=1                       # Verschl�sselung (DATA_KEY/Pi): nur vault/ sichern
# GITHUB_TOKEN=...              # nur bei privatem Repo, siehe unten
```

Das Skript muss die Daten lesen und `docker` aufrufen dürfen: entweder als
Nutzer in der Gruppe `docker`, dem der Datenordner gehört, oder per `sudo crontab -e`.
`VAULT=1` legt fest, dass nur `vault/` gesichert wird und `.update-request`/`.update-status` dort liegen. Das Skript leitet das nicht mehr aus dem Datenordner ab (den kann der Container beschreiben). Fehlt `VAULT` in `.update.env` und es gibt einen Ordner `vault/` im Datenpfad, tr�gt das Skript einmalig `VAULT=1` ein.

Empfohlen ohne Root: eigener Systemnutzer in der Gruppe `docker`, dem der Repo-Ordner geh�rt, mit dem Cron-Eintrag dieses Nutzers (`crontab -e` als dieser Nutzer) statt `sudo crontab -e`. Das Skript folgt keinen Symlinks im Datenordner (Status per Temp-Datei + `mv -fT`, `.update-request` nur als regul�re Datei).

Unter Windows mit Docker Desktop läuft es in Git Bash oder WSL (ohne Cron von Hand).

### Zurück auf ein Backup

```bash
docker compose down
tar -xzf <BACKUP_DIR>/data-<datum>-<version>.tar.gz -C <Elternordner des Datenordners>
# mit Verschlüsselung: -C <LATEX_DATA_DIR> (das Archiv enthält vault/)
# Quellstand: das Update-Skript arbeitet mit Release-Archiven, nicht mit git. Den alten Stand
# (Release-Archiv der alten Version) über den Programmordner entpacken, .env/data/backups bleiben:
tar -xzf <alte-version>.tar.gz -C /pfad/zu/LaTeX-IDE --strip-components=1
echo <alter-tag> > /pfad/zu/LaTeX-IDE/.release   # sonst hält das Skript den Stand für aktuell/neuer
docker compose up -d --build
```

Hinweis: Die Daten des Backups gehören zur alten Version. Nach einem Rollback läuft der
Server mit dem alten Code und dem alten Datenstand; zwischenzeitlich angelegte Konten und
Änderungen sind weg. Eine neuere Datenstruktur kann ein älterer Server nicht lesen, deshalb
immer Code und Backup derselben Version zusammen zurückspielen.

## Öffentliches oder privates Repository

**Öffentlich:** nichts weiter nötig. Server, Update-Skript und Desktop-Downloads
greifen ohne Anmeldung auf die GitHub-Releases zu.

<a id="privates-repository"></a>
**Privat:** GitHub antwortet ohne Anmeldung mit 404. Dann braucht der Server
einen Lese-Token:

1. GitHub → Settings → Developer settings → Fine-grained tokens → „Generate new token“.
2. Repository access: „Only select repositories“ → `LaTeX-IDE`.
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

Das GitHub-Repo fuer Update-Check und Downloads steht in `UPDATE_REPO` (`.env`, Standard `felix-d-git/LaTeX-IDE`); Forks setzen es auf ihr eigenes Repo.

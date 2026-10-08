# Server mit Docker (Linux, Raspberry Pi, Docker Desktop)

Für einen Server, auf dem mehrere Konten arbeiten: Heimserver, VPS, Raspberry Pi
oder ein Rechner mit Docker Desktop. Der Server liefert die Weboberfläche aus
und bietet angemeldeten Nutzern die Desktop-App zum Download an.

Zurück zur [Übersicht](../README.md#installation) · Updates: [UPDATES.md](UPDATES.md)

## Voraussetzungen

| | Minimum | Empfohlen |
|---|---|---|
| CPU | x86_64 oder ARM64 (z. B. Raspberry Pi 4/5, 64-Bit-OS) | 4 Kerne |
| RAM | 2 GB | 4 GB+ (Kompilieren großer Dokumente braucht ~1 GB) |
| Speicher | ~8 GB frei (TeX Live im Image ~5 GB) | SSD statt SD-Karte |
| Software | Docker mit Compose-Plugin (`docker compose version`), git | – |

Docker installieren (Debian/Ubuntu/Raspberry Pi OS):

```bash
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker "$USER"   # danach ab- und wieder anmelden
```

## Installation

```bash
git clone https://github.com/felix-d-git/latex-web-ide.git
cd latex-web-ide
git checkout "$(git describe --tags --abbrev=0)"   # neuestes Release statt Entwicklungsstand
cp .env.example .env
nano .env                                          # PUBLIC_URL, ADMIN_EMAIL, ADMIN_PASSWORD
mkdir -p data                                      # vorher anlegen, sonst gehört er root
docker compose up -d --build                       # erster Build dauert (TeX Live)
```

**Repository noch privat?** Dann klappt `git clone` nur mit Zugang: entweder
per SSH-Schlüssel (`git clone git@github.com:felix-d-git/latex-web-ide.git`)
oder mit einem Lese-Token (siehe [UPDATES.md](UPDATES.md#privates-repository)):
`git clone https://<token>@github.com/felix-d-git/latex-web-ide.git`. Alternativ
auf GitHub unter Releases „Source code (tar.gz)“ herunterladen und entpacken.

Danach unter `http://<server>:3077` mit `ADMIN_EMAIL` / `ADMIN_PASSWORD`
anmelden. Weitere Konten entstehen über Einladungslinks (Profil → Einladungen).

### Wichtige Einstellungen in `.env`

| Variable | Bedeutung |
|---|---|
| `PUBLIC_URL` | Adresse, unter der der Server von außen erreichbar ist. Steht in Einladungslinks und wird in die Desktop-App eingebaut. |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD` | Erstes Admin-Konto (nur beim allerersten Start). |
| `COOKIE_SECURE` | `true`, sobald HTTPS davor sitzt. |
| `HOST_PORT` | Port auf dem Host (Standard 3077). |
| `LATEX_DATA_DIR` | Datenordner auf dem Host (Standard `./data`). |
| `TEXLIVE` | `apt` (Debian-Paket im Image, Standard) oder `host` (eigenes TeX Live einhängen). |
| `UPDATE_MODE` | `notify` / `button` / `auto` / `off`, siehe [UPDATES.md](UPDATES.md). |
| `DATA_KEY`, `VAULT_DIR` | Daten verschlüsselt auf der Platte, siehe README „Verschlüsselte Daten“. |
| `SMTP_*` | Mailversand für Einladungen/Passwort-Reset (ohne: Links im Log). |

## Von außen erreichbar machen

Reverse Proxy mit HTTPS (Caddy, nginx, Traefik …) auf Port 3077 und Websockets
durchreichen. Dann in `.env` `PUBLIC_URL=https://…` und `COOKIE_SECURE=true`
setzen und `docker compose up -d` erneut ausführen.

Beispiel Caddy (`/etc/caddy/Caddyfile`, Websockets gehen automatisch durch):

```
latex.example.org {
    reverse_proxy 127.0.0.1:3077
}
```

Ohne eigene Domain: **Tailscale Funnel**. `docker-compose.pi.yml` bringt dafür einen
Tailscale-Container mit (`TS_AUTHKEY` in `.env`, Adresse dann
`https://latex.<tailnet>.ts.net`).

## Raspberry Pi / kleiner Server: `docker-compose.pi.yml`

Variante mit Tailscale Funnel, Speicherlimits, TeX Live vom Host und
verschlüsselten Daten (Klartext nur im RAM):

```bash
node server/lib/vault.js keygen          # bzw. im Container: docker run --rm latex-collab node server/lib/vault.js keygen
# .env: DATA_KEY, SESSION_SECRET, ADMIN_*, PUBLIC_URL, TS_AUTHKEY,
#       LATEX_DATA_DIR=/pfad/auf/ssd, LATEX_TEXLIVE_DIR=/pfad/zu/texlive
mkdir -p "$LATEX_DATA_DIR/vault" && sudo chown 1000:1000 "$LATEX_DATA_DIR/vault"
docker compose -f docker-compose.pi.yml up -d --build
```

- TeX Live 2025 vorher auf dem Host installieren (install-tl, Ziel z. B. auf der SSD).
- `DATA_KEY` getrennt von den Daten sichern (Passwortmanager): ohne ihn sind
  Daten und Backups unlesbar.
- Limits per `.env`: `LATEX_MEM` (Standard 1g), `LATEX_CPUS`, `LATEX_TMPFS`.

## Eigenes TeX Live statt Debian-Paket

Debian liefert TeX Live 2022. Für eine neuere Version oder TeX Live auf einer
anderen Platte: TeX Live installieren, in `.env` `TEXLIVE=host` setzen und in
`docker-compose.override.yml` einhängen:

```yaml
services:
  app:
    volumes:
      - /pfad/zu/texlive:/data/texlive:ro
```

Eigene Anpassungen (Port, Speicherlimit, Proxy-Netz) gehören immer in
`docker-compose.override.yml` – Updates fassen die Datei nicht an.

## Docker Desktop (Windows/macOS)

1. [Docker Desktop](https://www.docker.com/products/docker-desktop/) installieren
   (unter Windows mit WSL 2) und starten.
2. GitHub → Releases → neuestes Release → „Source code (zip)“ herunterladen und
   entpacken (oder `git clone` wie oben).
3. Im Ordner `.env.example` nach `.env` kopieren und ausfüllen, Ordner `data` anlegen.
4. Im Ordner ein Terminal öffnen und `docker compose up -d --build` ausführen.
5. `http://localhost:3077` öffnen.

Docker Desktop startet den Container nach einem Neustart wieder, wenn „Start
Docker Desktop when you sign in“ aktiv ist. Das Update-Skript läuft unter
Windows in Git Bash oder WSL.

## Fertiges Image (nur bei öffentlichem Repository)

Jedes Release wird per CI gebaut und getestet. Ist das Repository öffentlich,
liegt das Image zusätzlich unter `ghcr.io/felix-d-git/latex-web-ide:<version>`
(x86_64). Solange es privat ist, gibt es kein fertiges Image – selbst bauen wie oben.

## Datensicherung

- Alles Wichtige liegt in `LATEX_DATA_DIR` (mit Verschlüsselung: `…/vault`) und `.env`.
- Das Update-Skript sichert den Datenordner vor jedem Update nach `BACKUP_DIR`
  (die letzten 3 bleiben).
- Manuell: `sudo tar -czf latex-backup-$(date +%F).tar.gz -C <LATEX_DATA_DIR> .` plus
  eine Kopie von `.env` (enthält Passwörter/Schlüssel → `chmod 600`).

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
mkdir -p data && sudo chown 1000:1000 data         # vorher anlegen; der Container läuft als uid 1000, sonst Neustartschleife
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
| `DATA_KEY`, `VAULT_DIR` | Daten verschlüsselt auf der Platte, siehe README „Verschlüsselte Daten“. Nur mit `docker-compose.pi.yml` lauffähig (tmpfs + Vault-Volume), nicht mit `docker-compose.yml`. |
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

Beispiel nginx (Host-Header und Websocket-Upgrade sind Pflicht, sonst scheitern Login-Prüfung und `/ws`):

```
location / {
    proxy_pass http://127.0.0.1:3077;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
}
```

Apache: `ProxyPreserveHost On` plus `mod_proxy_wstunnel`.

Ohne eigene Domain: **Tailscale Funnel**. `docker-compose.pi.yml` bringt dafür einen
Tailscale-Container mit (`TS_AUTHKEY` in `.env`, Adresse dann
`https://latex.<tailnet>.ts.net`).

## Raspberry Pi / kleiner Server: `docker-compose.pi.yml`

Variante mit Tailscale Funnel, Speicherlimits, TeX Live vom Host und
verschlüsselten Daten (Klartext nur im RAM):

```bash
openssl rand -hex 32                     # zweimal: DATA_KEY und SESSION_SECRET (kein Node/Image nötig)
# .env: DATA_KEY, SESSION_SECRET, ADMIN_*, PUBLIC_URL, TS_AUTHKEY,
#       LATEX_DATA_DIR=/pfad/auf/ssd, LATEX_TEXLIVE_DIR=/pfad/zu/texlive
mkdir -p "$LATEX_DATA_DIR/vault" && sudo chown 1000:1000 "$LATEX_DATA_DIR/vault"
docker compose -f docker-compose.pi.yml up -d --build
```

- Der Vault-Ordner muss vorher existieren und UID 1000 gehören (Zeile `mkdir`/`chown`
  oben). Sonst bricht der Container-Start mit „VAULT_DIR … nicht beschreibbar“ ab.
- TeX Live 2025 vorher auf dem Host installieren (install-tl, Ziel z. B. auf der SSD).
- `DATA_KEY` getrennt von den Daten sichern (Passwortmanager): ohne ihn sind
  Daten und Backups unlesbar.
- Limits per `.env`: `LATEX_MEM` (Standard 1g), `LATEX_CPUS`, `LATEX_TMPFS`.
- Das Image `tailscale/tailscale` wird nur referenziert und beim Start von
  Docker Hub geladen, es ist nicht Teil dieses Projekts. Für Konto und Funnel
  gelten die [Nutzungsbedingungen von Tailscale](https://tailscale.com/terms)
  und die Bedingungen des gewählten Tarifs. Der Verkehr aus dem Internet läuft
  über die Funnel-Relay-Server von Tailscale (verschlüsselt, TLS endet erst im
  Tailscale-Container).

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

Der Ordner muss `<Jahr>/bin/<arch>` enthalten (Jahr 2025–2027, `x86_64-linux` oder
`aarch64-linux`). Prüfen: `docker compose exec app latexmk -v`.

Eigene Anpassungen (Port, Speicherlimit, Proxy-Netz) gehören immer in
`docker-compose.override.yml` – Updates fassen die Datei nicht an.

## Docker Desktop (Windows/macOS)

Docker Desktop ist nur für Privatnutzung, Bildung, nicht-kommerzielle
Open-Source-Projekte und kleine Unternehmen (unter 250 Beschäftigte und unter
10 Mio. US-Dollar Jahresumsatz) kostenlos; größere Unternehmen und Behörden
brauchen ein kostenpflichtiges Abo
([Lizenzbedingungen](https://docs.docker.com/subscription/desktop-license/)).
Kostenlose Alternativen: Docker Engine in WSL 2 (Windows),
[Rancher Desktop](https://rancherdesktop.io/),
[Podman Desktop](https://podman-desktop.io/) oder
[Colima](https://github.com/abiosoft/colima) (macOS).

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
(x86_64, TeX Live aus Debian). Solange es privat ist, gibt es kein fertiges
Image – selbst bauen wie oben.

**Mit pandoc:** Das fertige Image enthält pandoc für den Export nach Word,
Markdown und HTML (File ▸ Download). Debians pandoc ist statisch mit rund 140
Haskell-Bibliotheken gelinkt (u. a. unter GPL-2.0+). Deren Debian-Quellpakete
liegen deshalb zu jedem Release mit veröffentlichtem Image als
`pandoc-sources-<tag>.tar` bei den Release-Dateien (siehe unten). Beim eigenen
Build steuert das Build-Argument `PANDOC` pandoc (Standard `1`, mit `0` ohne).

## Drittsoftware im Docker-Image

Das Image enthält neben der IDE (AGPL-3.0-only) Debian-Pakete unter eigenen
Lizenzen, u. a. unter GPL, LGPL und AGPL:

- Debian-Basissystem (`node:24-bookworm-slim`), z. B. bash und coreutils
  (GPL-3.0+), mawk (GPL-2.0), glibc und GMP (LGPL)
- `perl` (GPL-1.0+ oder Artistic)
- beim Standard-Build (`TEXLIVE=apt`): `texlive-full` und `latexmk` (u. a. GPL,
  LPPL) mit ihren Abhängigkeiten, darunter Ghostscript/libgs (AGPL-3.0+),
  ImageMagick 6 (ImageMagick-Lizenz), poppler (GPL), Qt 5 und MPFR (LGPL)
- `pandoc` (GPL-2.0+) mit statisch gelinkten Haskell-Bibliotheken (fehlt bei
  `PANDOC=0`)

Copyright-Vermerke und Lizenzen der Pakete liegen im Image unter
`/usr/share/doc/<paket>/copyright`, die Volltexte gängiger Lizenzen unter
`/usr/share/common-licenses/`, die Lizenz von Node.js unter `/usr/local/LICENSE`.
Das Basisimage ist eine „slim“-Variante: Von `/usr/share/doc` bleiben nur die
`copyright`- und `NOTICE`-Dateien, Handbücher, Manpages und der Inhalt der
`texlive-*-doc`-Pakete fehlen. Vollständig sind sie in den Debian-Paketen und
deren Quellen.

Die genauen Pakete und Versionen stehen im Image unter `/app/DEBIAN-PACKAGES.txt`,
tabulatorgetrennt mit den Spalten Paket, Version, Quellpaket, Quellversion,
Built-Using und Static-Built-Using (die letzten beiden nennen weitere
Quellpakete, die beim Bauen in das Paket eingeflossen sind, meist leer):

```bash
docker run --rm ghcr.io/felix-d-git/latex-web-ide:<version> cat /app/DEBIAN-PACKAGES.txt
```

Zu jedem Release mit veröffentlichtem Image liegt dieselbe Liste als
`DEBIAN-PACKAGES-<tag>.txt` bei den Release-Dateien auf GitHub, dazu
`pandoc-sources-<tag>.tar`: die Debian-Quellpakete (`.dsc`, `.orig.tar.*`,
`.debian.tar.*`) von pandoc, ghc und aller Haskell-Bibliotheken, gegen die pandoc laut
offizieller Debian-buildinfo gebaut wurde (`libghc-*-dev`), Liste in
`SOURCES.txt`. Die Datei wird vor dem
Image veröffentlicht und bleibt mindestens drei Jahre nach der letzten
Verteilung des Images beim Release.

Die Quellen genau dieser Versionen, auch der unter Built-Using und
Static-Built-Using genannten, liegen unter <https://snapshot.debian.org>
(`https://snapshot.debian.org/package/<Quellpaket>/<Quellversion>/`).
Node.js stammt aus dem offiziellen Image `node:24-bookworm-slim` (Quellen:
<https://github.com/nodejs/node>), die npm-Abhängigkeiten der IDE stehen in
`THIRD_PARTY_NOTICES.md` bzw. unter `/licenses` im laufenden Server. Der
Quellcode der IDE selbst liegt im Image unter `/app`.

Für Downloads des Images von ghcr.io wird der Quellcode nach GPL-3.0, AGPL-3.0
und LGPL-3.0 (jeweils §6 d) über diese Hinweise und snapshot.debian.org
bereitgestellt. Das folgende Angebot gilt zusätzlich, vor allem für Teile unter
GPL-2.0 wie mawk.

**Schriftliches Angebot:** Für jede auf ghcr.io veröffentlichte Version des
Images stellt felix-d-git jedem Dritten den vollständigen Quellcode aller darin
enthaltenen Programme und Bibliotheken unter GPL, LGPL und AGPL (jeweils aller
Versionen) bereit, einschließlich statisch eingebundener Bibliotheken: als
Debian-Quellpakete (`.dsc`, `.orig.tar.*`, `.debian.tar.*`) per Download oder auf
einem Datenträger zu Selbstkosten. Die Anfrage nennt Tag und Digest des Images
(`docker inspect --format '{{index .RepoDigests 0}}' <image>`). Das Angebot gilt
drei Jahre ab der letzten Verteilung der jeweiligen Version. Anfrage als
GitHub-Issue unter <https://github.com/felix-d-git/latex-web-ide/issues>; das
Repository bleibt dafür mindestens bis zum Ende dieser Frist öffentlich und nimmt
Issues an.

## Hinweise für Betreiber

- Lizenzdateien nicht entfernen: `LICENSE`, `THIRD_PARTY_NOTICES.md`,
  `DEBIAN-PACKAGES.txt` und `docs/` unter `/app` sowie
  `/usr/share/doc/*/copyright`. `/licenses` zeigt `LICENSE` und
  `THIRD_PARTY_NOTICES.md` auch ohne Anmeldung.
- `UPDATE_REPO` (`.env` bzw. `.update.env`) zeigt standardmäßig auf dieses
  Repository. Wer dort einen Fork einträgt, bezieht Code und Updates aus dem Fork
  und ist für dessen Inhalt und Lizenzhinweise selbst verantwortlich.
- Wer den Code ändert und den Server anderen über das Netz anbietet, muss diesen
  Nutzern den Quellcode der geänderten Fassung anbieten (AGPL-3.0 §13), z. B.
  per Link auf das eigene Repository.
- Wer ein selbst gebautes Image weitergibt (z. B. in eine eigene Registry
  pusht), verbreitet die enthaltene Drittsoftware selbst und muss deren
  Quellcode wie oben bereitstellen, mit pandoc auch den der statisch gelinkten
  Haskell-Bibliotheken.
- Große Projekte (viele Dateien/Ordner) brauchen genug inotify-Watches auf dem
  Host, sonst erkennt der Server externe Dateiänderungen nicht mehr live (Log:
  `[watcher] … ENOSPC`): `sysctl -w fs.inotify.max_user_watches=524288`,
  dauerhaft per Datei unter `/etc/sysctl.d/`.

## Datensicherung

- Alles Wichtige liegt in `LATEX_DATA_DIR` (mit Verschlüsselung: `…/vault`) und `.env`.
- Das Update-Skript sichert den Datenordner vor jedem Update nach `BACKUP_DIR`
  (die letzten 3 bleiben).
- Manuell: `sudo tar -czf latex-backup-$(date +%F).tar.gz -C <LATEX_DATA_DIR> .` plus
  eine Kopie von `.env` (enthält Passwörter/Schlüssel → `chmod 600`).

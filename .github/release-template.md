
---

## Welche Datei brauche ich?

| Ich will … | Datei | Anleitung |
|---|---|---|
| einen **Server** für mehrere Konten betreiben (Linux, Raspberry Pi, Docker Desktop) | **Source code** (zip/tar.gz) bzw. `git clone`, dann `docker compose up -d --build` | [Server mit Docker](https://github.com/felix-d-git/latex-web-ide/blob/{{TAG}}/docs/INSTALL-DOCKER.md) |
| einen **Server auf einem Windows-PC ohne Docker** | `LatexIDE-Setup.exe` → Betriebsart „Eigener Server“ | [Windows](https://github.com/felix-d-git/latex-web-ide/blob/{{TAG}}/docs/INSTALL-WINDOWS.md) |
| mich als **Desktop-App** mit einem bestehenden Server verbinden (offline arbeiten) | am besten aus der Weboberfläche des Servers (Profil → „Desktop-App herunterladen“); sonst `LatexIDE-Setup.exe` (Windows) / `LatexIDE-macOS.zip` (macOS) | [Desktop-App](https://github.com/felix-d-git/latex-web-ide/blob/{{TAG}}/docs/DESKTOP-APP.md) |
| **allein an einem Windows-Rechner** schreiben, ohne Server und ohne Konto | `LatexIDE-Setup.exe` → Betriebsart „Nur dieser Rechner (100 % lokal)“ | [Windows](https://github.com/felix-d-git/latex-web-ide/blob/{{TAG}}/docs/INSTALL-WINDOWS.md#100--lokal-betrieb) |

- `LatexIDE-Setup.exe` enthält alle drei Windows-Varianten; das Setup fragt danach.
- Setup und macOS-Paket laden TeX Live 2025 bzw. MacTeX (~5 GB), falls noch keines da ist; das Docker-Image bringt TeX Live aus Debian mit.
- Bestehenden Server aktualisieren: [Updates](https://github.com/felix-d-git/latex-web-ide/blob/{{TAG}}/docs/UPDATES.md). Desktop-Apps aktualisieren sich danach selbst über ihren Server.
- Lizenz: LatexIDE ist freie Software unter der [AGPL-3.0-only](https://github.com/felix-d-git/latex-web-ide/blob/{{TAG}}/LICENSE), Quellcode genau dieses Releases: [{{TAG}}](https://github.com/felix-d-git/latex-web-ide/tree/{{TAG}}). `LatexIDE-Setup.exe` enthält Node.js (Lizenz in `node\LICENSE`), das macOS-Paket lädt Node.js von nodejs.org; TeX Live/MacTeX sind nicht enthalten, sondern werden bei Bedarf von einem TUG-Spiegel geladen. Drittlizenzen: in der App unter `/licenses` und in [THIRD_PARTY_NOTICES.md](https://github.com/felix-d-git/latex-web-ide/blob/{{TAG}}/THIRD_PARTY_NOTICES.md) (liegt jedem Paket bei).

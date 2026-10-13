# Windows ohne Docker: eigener Server oder 100 % lokal

Beide Varianten stecken in derselben Datei `LatexIDE-Setup.exe` (dazu die
Desktop-App, siehe [DESKTOP-APP.md](DESKTOP-APP.md)). Das Setup fragt nach der
Betriebsart.

Zurück zur [Übersicht](../README.md#installation)

| Betriebsart | Für | Konten | Erreichbar von |
|---|---|---|---|
| **Eigener Server auf diesem Rechner** | kleine Gruppe, ein Windows-PC läuft ohnehin | ja, Einladungen | anderen Rechnern im Netz (oder per Proxy von außen) |
| **Nur dieser Rechner (100 % lokal, ohne Konto)** | allein an einem Rechner schreiben | nein | nur diesem Rechner (`127.0.0.1`) |

## Voraussetzungen

- Windows 10/11, 64 Bit. Keine Admin-Rechte nötig (Installation pro Benutzer).
- ~8 GB frei, davon ~5 GB für TeX Live 2025. Ist bereits ein TeX Live mit
  `latexmk` im PATH, wird der Download übersprungen.
- Internet beim Installieren (TeX Live kommt aus dem Netz, je nach Leitung
  bis zu mehreren Stunden).

## Installation

1. GitHub → Releases → neuestes Release → `LatexIDE-Setup.exe` herunterladen.
   (Repository noch privat? Dann nur mit GitHub-Zugang zum Repo; oder jemand mit
   Zugang reicht die Datei weiter.)
2. Setup starten. Windows SmartScreen meldet einen unbekannten Herausgeber
   (das Setup ist nicht signiert) → „Weitere Informationen“ → „Trotzdem ausführen“.
3. Betriebsart wählen:
   - **Eigener Server**: Admin-E-Mail und -Passwort festlegen (mind. 8 Zeichen).
   - **100 % lokal**: keine weiteren Angaben.
4. Danach öffnet sich ein Fenster für die TeX-Live-Installation – offen lassen,
   bis es fertig ist.
5. Start über das Startmenü („LatexIDE“) → der Browser öffnet `http://localhost:3077`.

## Eigener Server: Betrieb

- Der Server läuft in einem minimierten Konsolenfenster; Schließen des Fensters
  beendet ihn. Kein Autostart – bei Bedarf eine Verknüpfung in
  `shell:startup` legen.
- Einstellungen: `%LOCALAPPDATA%\Programs\LatexIDE\.env` (Bedeutung wie in
  [INSTALL-DOCKER.md](INSTALL-DOCKER.md#wichtige-einstellungen-in-env)).
- Daten: `%LOCALAPPDATA%\LatexIDE\server-data` – diesen Ordner sichern.
- Andere Rechner im Netz: `http://<rechnername>:3077`. Dafür beim ersten Start
  die Windows-Firewall-Frage für Node.js im privaten Netz erlauben und
  `PUBLIC_URL=http://<rechnername>:3077` in `.env` setzen (dann neu starten).
- Von außen erreichbar: Reverse Proxy oder Tailscale Funnel davor, dann
  `PUBLIC_URL=https://…` und `COOKIE_SECURE=true`.
- Desktop-Apps für andere Rechner: nach dem Login unter Profil →
  „Desktop-App herunterladen“.

## 100 % lokal: Betrieb

- Kein Login, kein Konsolenfenster, nur `127.0.0.1`. Das Startmenü-Symbol
  startet einen unsichtbaren Server und öffnet den Browser.
- Schließt man das letzte Browserfenster, sichert der Server alles und beendet
  sich nach etwa 30 s. Ein zweiter Start bei laufendem Server öffnet nur den Browser.
- Hat der Browser einen lange inaktiven Tab verworfen, ist der Server evtl.
  schon beendet → LatexIDE erneut aus dem Startmenü starten.
- Daten: `%LOCALAPPDATA%\LatexIDE\local-data` – diesen Ordner sichern.
- Teilen und Einladen gibt es hier nicht; dafür einen Server betreiben.

## Updates

Neues `LatexIDE-Setup.exe` aus dem neuesten Release herunterladen und über die
bestehende Installation installieren, dieselbe Betriebsart wählen. `.env`,
Daten und TeX Live bleiben erhalten. Admins des eigenen Servers sehen im
Web-UI ein Banner, sobald ein neues Release erscheint (Standard `UPDATE_MODE=notify`;
das automatische Update-Skript gibt es nur für Docker).

## Deinstallieren

Windows-Einstellungen → Apps → LatexIDE. Die vom Installer angelegte TeX-Live-
Installation, Caches und die `.env` werden entfernt (Admin-Zugangsdaten gelten
nach einer Neuinstallation also neu). Projekte und Einstellungen löscht der
Deinstaller nur nach Rückfrage.

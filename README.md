# LaTeX Web IDE

Lokale, Overleaf-artige Web-Oberfläche für LaTeX-Projekte. Nutzt eine **lokal
installierte TeX-Distribution** (hier: TeX Live 2025, `latexmk`/`pdflatex`
müssen im `PATH` sein) statt eines Cloud-Compilers, damit alle installierten
Pakete und Makros exakt wie beim finalen Kompilieren zur Verfügung stehen.

## Start

```
start.bat        (Windows)
./start.sh       (Linux/macOS/Raspberry Pi)
```

Öffnet danach `http://localhost:3077` im Browser. Beim allerersten Start wird
automatisch ein Admin-Konto angelegt (siehe "Accounts / Login" unten) - danach
über "Projekt öffnen…" den Pfad zu einem lokalen LaTeX-Projektordner angeben
(z.B. `projects/Bachelor_Arbeit_4`, testweise bereits enthalten).

`projects/_ide_test` ist ein minimales, garantiert sauber kompilierendes
Testdokument (Umlaute, Formel, Liste) — damit lässt sich nach Änderungen an
der IDE schnell prüfen, ob Dateibaum/Editor/Compile/PDF-Vorschau noch
funktionieren, ohne von Fehlern im echten Thesis-Projekt abzulenken. Siehe
[STATUS.md](STATUS.md) für den aktuellen Test-/Reparaturstand.

## Funktionen

- Dateibaum (links), Editor mit Tabs (Mitte, CodeMirror 6 + LaTeX-Highlighting),
  PDF-Vorschau (rechts, PDF.js)
- Autosave beim Tippen (debounced)
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
  `ADMIN_PASSWORD`/`SESSION_SECRET` setzen (ohne `.env` wird ein Fallback-Admin
  `admin@local.host` / `bitte-sofort-aendern` angelegt - Passwort direkt danach über
  "Passwort vergessen" ändern). `SESSION_SECRET` unbedingt dauerhaft setzen,
  sonst gehen bei jedem Neustart alle Logins verloren.
- **Projekt-Isolation:** Der Admin behält den bestehenden `projects/`-Ordner
  (inkl. `Bachelor_Arbeit_4`) unverändert. Jeder eingeladene Nutzer bekommt
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

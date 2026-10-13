# Desktop-App (Windows, macOS)

Für alle, die ein Konto auf einem LatexIDE-Server haben und auch offline
schreiben und lokal kompilieren wollen. Die App hält eine lokale Kopie der
eigenen Projekte und gleicht sie mit dem Server ab; geteilte Projekte und die
Zusammenarbeit laufen weiter über den Server.

Zurück zur [Übersicht](../README.md#installation)

## Voraussetzungen

- Ein Konto auf einem LatexIDE-Server (Einladung vom Admin).
- Windows 10/11 (64 Bit) oder macOS (Apple Silicon oder Intel).
- ~6 GB frei für TeX Live 2025 bzw. MacTeX (wird bei der Installation geladen,
  falls noch keines vorhanden ist).

## Herunterladen

**Empfohlen – vom eigenen Server:** in der Weboberfläche anmelden → Profil →
„Desktop-App herunterladen“ → Windows oder macOS. Dieses Paket hat die Adresse
des Servers schon eingebaut und passt immer zur Server-Version.

**Alternativ – aus den GitHub-Releases:** `LatexIDE-Setup.exe` (Windows) bzw.
`LatexIDE-macOS.zip` (macOS). Dann fragt die Installation nach der
Server-Adresse (z. B. `https://latex.example.org`, genau wie im Browser). Die
Release-Version sollte zur Version des Servers passen (steht im Update-Banner
bzw. beim Admin).

## Installation Windows

1. `LatexIDE-Setup.exe` starten (SmartScreen: „Weitere Informationen“ →
   „Trotzdem ausführen“, das Setup ist nicht signiert).
2. Betriebsart **„Desktop-App (mit einem Server verbinden)“** wählen.
3. Server-Adresse prüfen bzw. eintragen.
4. Ordner für die **lokale Kopie** wählen (Standard `Dokumente\LatexIDE`). Der
   Ordner bleibt bei Updates gleich.
5. TeX Live installiert sich danach in einem eigenen Fenster (bei vorhandenem
   `latexmk` übersprungen).

## Installation macOS

1. `LatexIDE-macOS.zip` entpacken, `install.command` doppelklicken. Weil die
   Datei nicht signiert ist, blockt Gatekeeper sie: Systemeinstellungen →
   Datenschutz & Sicherheit → „Dennoch öffnen“ (bis macOS 14 reicht
   Rechtsklick → „Öffnen“). Falls macOS die Datei gar nicht ausführt: im
   Terminal im entpackten Ordner `bash install.command`.
2. Das Skript lädt Node.js, kopiert die App nach `~/Applications/LatexIDE` und
   installiert MacTeX, falls noch keines da ist.
3. Starten über `~/Applications/LatexIDE/LatexIDE.command`.

## Erster Start und Anmeldung

1. Die App öffnet im Browser die Seite „Anmelden – Desktop-App verbinden“ des Servers.
2. Mit dem eigenen Konto anmelden. Die App bekommt dadurch einen eigenen
   Zugangsschlüssel; das Passwort wird nicht auf dem Rechner gespeichert.
3. Der Browser springt zurück zur App (`http://localhost:…`), die nun die eigenen
   Projekte in die lokale Kopie lädt.

Verbundene Apps stehen in der Weboberfläche unter Profil → „Verbundene
Desktop-Apps“. „Trennen“ meldet eine App sofort ab (z. B. bei verlorenem Laptop);
sie verlangt danach eine neue Anmeldung.

## Offline arbeiten

- Offline bearbeitbar und lokal kompilierbar sind Dateien von eigenen Projekten, die auf diesem Gerät mindestens einmal online geöffnet wurden (nur diese liegen in der lokalen Kopie).
- Sobald der Server wieder erreichbar ist, gleicht die App die Änderungen ab.
  Wurde dieselbe Datei auch auf dem Server geändert, bleibt die Server-Fassung
  und die lokale liegt daneben als `*.offline-konflikt.*`.
- Der Ordner der lokalen Kopie lässt sich in den Einstellungen der App ändern
  (die Projekte werden verschoben).
- Für geteilte Projekte und Live-Zusammenarbeit braucht es die Verbindung.

## Updates

Die App fragt ihren Server nach der Version. Läuft der Server auf einer neueren
Version, erscheint „Update verfügbar – jetzt installieren“. Windows installiert
das neue Setup still und startet die App neu, macOS entpackt das Update über den
App-Ordner. Die App wird nie neuer als ihr Server.

Desktop-Apps der Version 0.2.0 holen Updates noch direkt von GitHub; diese
einmal mit dem Setup aus der Weboberfläche neu installieren.

## Probleme

- **„Keine Server-Adresse“**: Setup direkt von GitHub ohne Adresse installiert →
  Setup erneut ausführen und die Adresse eintragen, oder das Paket aus der
  Weboberfläche nehmen.
- **Anmeldung schlägt fehl**: Adresse im Browser prüfen; App unter „Verbundene
  Desktop-Apps“ trennen und neu anmelden.
- **Kompilieren schlägt lokal fehl**: TeX-Live-Installation unvollständig →
  Setup erneut ausführen (TeX Live wird nur installiert, wenn `latexmk` fehlt).

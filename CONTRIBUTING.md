# Beiträge

Danke fürs Mitmachen! Fehler und Vorschläge bitte als
[Issue](https://github.com/felix-d-git/LaTeX-IDE/issues), Änderungen als Pull Request.

## Lizenz von Beiträgen

Das Projekt steht unter der GNU Affero General Public License, ausschließlich
Version 3 (`AGPL-3.0-only`, siehe [LICENSE](LICENSE)). Beiträge werden unter
derselben Lizenz angenommen („inbound = outbound“, vgl. Abschnitt D.6 der
GitHub-Nutzungsbedingungen). Mit einem Pull Request bestätigst du, dass du den
Beitrag unter dieser Lizenz einbringen darfst.

- Ein Contributor License Agreement (CLA) gibt es nicht; das Urheberrecht an
  deinem Beitrag bleibt bei dir. Der Maintainer kann das für künftige Beiträge
  ändern; bereits angenommene Beiträge bleiben davon unberührt.
- Jeder Commit braucht ein Sign-off nach dem
  [Developer Certificate of Origin 1.1](https://developercertificate.org/):
  `git commit -s` (Zeile `Signed-off-by: Name <E-Mail>`). Damit bestätigst du,
  dass du den Beitrag einbringen darfst. Der Check „DCO“ prüft das bei jedem
  Pull Request; fehlende Sign-offs nachholen mit
  `git rebase --signoff <Basis>` und erneutem Push.
- Neue Quelldateien beginnen (nach einer Shebang-Zeile) mit dem SPDX-Kopf
  in der Kommentarsyntax der Datei:
  ```
  // SPDX-License-Identifier: AGPL-3.0-only
  // SPDX-FileCopyrightText: 2026 felix-d-git and LaTeX-IDE contributors
  ```
  Dateien ohne Kommentarsyntax deckt `REUSE.toml` ab. Geprüft von
  `test/spdx.test.js` und `reuse lint` (Workflow „Licenses“).
- Fremden Code nur mit kompatibler Lizenz übernehmen und Herkunft samt
  Copyright-Zeile im Kopfkommentar der Datei nennen, dazu Lizenz und Inhaber
  im SPDX-Kopf ergänzen (z. B. `AGPL-3.0-only AND MIT`, siehe
  `server/lib/collab.js`) und den Lizenztext unter `LICENSES/` ablegen.

## Abhängigkeiten

Ändern sich Produktiv-Abhängigkeiten (`package.json`/`package-lock.json`),
`THIRD_PARTY_NOTICES.md` neu erzeugen und mit committen:

```
npm ci
node scripts/licenses.js
```

Das Skript meldet Lizenzen, die nicht auf seiner Positivliste stehen; solche
Pakete vorher klären. `client/dist/` wird nicht eingecheckt; `node build.js`
baut das Bundle nur zum lokalen Testen.

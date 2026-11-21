# Wave-Ledger

Base: master (tabu) · Second: staging/second-branch

## Entscheidungen
- 18.11.2026 Wave 1: #155 → worker_threads-Timeout + Längenlimits + Rate-Limit, keine neue native Dependency (re2 verworfen)
- 18.11.2026 Wave 1: #157 → Reviewer dürfen nur `anchors` eigener Kommentar-IDs ändern; pending structs ablehnen; Token-Bucket ~20 Updates/s; kleinere maxPayload für Reviewer
- 18.11.2026 Wave 1: #161 → Punkt 3 (tmpfs-Reserve) ausgeklammert, gehört zu #158
- 18.11.2026: BASE_BRANCH = master (main existiert nicht)
- 18.11.2026 Wave 2: #160 → reset-password setzt emailVerified im Modus admin nicht; forgot-password sendet unfreigegebenen Konten (admin-Modus) keine Mail, gleiche Antwort; Flag-Aufteilung verworfen (später)
- 18.11.2026 Wave 2: #159 → max. 2 eingereihte/laufende Compiles pro Nutzer (429), Rate-Limit pro Nutzer auf /api/compile + MCP compile, Reviewer kein clear-cache; Round-Robin + Timeout-Senkung verworfen
- 18.11.2026 Wave 2: #154 → TRUST_PROXY-Env, Default loopback, Pi-Compose passend; Login-Limit pro Konto, MAX_KEYS für Limiter-Map, MCP-Batch ≤20 sequentiell; Logging (Punkt 5) → #176
- 18.11.2026 Wave 2: #167 → requireTLS bei secure=false, TLS ≥1.2, Klartext nur mit SMTP_ALLOW_PLAIN=true (kein localhost-Automatismus), Hinweis im Admin-UI
- 18.11.2026 Wave 3: #153 → nur TOCTOU-Fix (Zeitstempel + Hash vor verifyPassword, Hash-Gleichheit danach); Sitzungsübersicht verworfen (später)
- 18.11.2026 Wave 3: #165 → COOKIE_SECURE auto/true/false (Default auto), CSRF-Cookie ebenso, HSTS nur bei req.secure ohne includeSubDomains, Start-Warnung; __Host--Präfix verworfen (meldet alle ab)
- 18.11.2026 Wave 3: #166 → stdout nur maskierte Adresse + Betreff, Outbox 0600 + 48h-Trim, bei konfiguriertem SMTP + Fehler kein Outbox-Eintrag; Admin-UI-Linkanzeige verworfen
- 18.11.2026 Wave 3: #170 → E-Mail nur für canManage + eigenen Eintrag, keine E-Mail bei Suche per Name, limitShare 30 Fehlversuche/15 min; Einladungs-Workflow verworfen
- 18.11.2026 Wave 4: #169 → Passwort nur bei gleichem Host/Port/User weiterverwenden, sonst Pflicht; mail/test generischer Fehler + Rate-Limit; Re-Auth verworfen, Audit-Log → #176
- 18.11.2026 Wave 4: #168 → umask 077 (Server+Desktop, nicht Windows), 0600 für Secret-Dateien, einmaliges chmod beim Start, server-update.sh umask 077 + Backup 700, Start-Warnung bei world-readable DATA_DIR
- 18.11.2026 Wave 4: #163 → Pro-Start-Schlüssel als HttpOnly-Cookie für Desktop-Proxy UND LOCAL_MODE (inkl. Starter), authView nur Port 3178; PKCE später
- 18.11.2026 Wave 4: #158 → Zip eintragsweise, ZIP_LIMIT 50 MB, USER_QUOTA_MB 300 (Admins frei), Kommentar ≤20 000, Label ≤100, max 50 gelabelte/Restore-Einträge, statfs-Reserve; Projektanzahl-Limit verworfen; alle Limits im Admin-Menü änderbar (Env = Default)
- 18.11.2026 Wave 5: #176 → audit.js (JSONL 0600, keine Secrets, Rotation 5 MB × 3, im Vault gespiegelt) + Hooks + Admin-Ansicht „Sicherheitsereignisse" + Banner-Warnung bei Schwellwert + optional AUDIT_SYSLOG
- 18.11.2026 Wave 5: #162 → Dateiname als AAD + Namensprüfung beim Restore + Migration alter Einträge + signiertes Manifest mit Generationszähler; abgelehntes Manifest = Start-Abbruch (wie falscher Schlüssel)
- 18.11.2026 Wave 5: #171 → atomares .update-status (tmp + mv), REQUEST nur reguläre Datei ohne Symlink, Vault-Modus aus `.update.env` VAULT=1 (einmalig automatisch gesetzt, wenn vault/ existiert); Nicht-Root nur dokumentiert, Cron unverändert
- 18.11.2026 Wave 5: #173 → permissions {} + Minimalrechte pro Job, persist-credentials false, npm ci --ignore-scripts, Build/Upload-Job getrennt, statischer YAML-Test; environment release mit Pflicht-Reviewern verworfen (ein Maintainer)
- 18.11.2026 Wave 6: #172 → SSH-signierte Tags, server-update.sh prüft per `git verify-tag` gegen host-eigene `APP_DIR/.release-signers` (nie vom Update überschrieben), auto-release.yml signiert mit Schlüssel aus Actions-Secret; zusätzlich Update-Stopp bei Änderung an docker-compose*/Dockerfile/server-update.sh (opt-in ALLOW_INFRA_CHANGES=1); 72-h-Verzögerung verworfen (Cooldown aus #204 reicht); Immutable Releases = Repo-Einstellung durch User
- 18.11.2026 Wave 6: #164 → Default-Scope neuer Tokens = genau ein Projekt, „Alle Projekte" nur per Opt-in, delete/move nie Default; Admin-Universum = mcpProjects(user); Fremdinhalt als Daten markiert + Vertrauenshinweis in instructions + docs/MCP.md; Session-Taint verworfen; bestehende Tokens unverändert
- 18.11.2026 Wave 6: #174 → nur kostenlose Teile: attest-build-provenance, SHA256SUMS-Asset, Hashprüfung in desktopAssets.js, keyless cosign + SBOM fürs Image; Authenticode/Apple-Notarisierung/Trailer-Ersatz später (Zertifikate fehlen)
- 18.11.2026 Wave 6: #175 → feste SHA-512 aus offiziellen TUG-.sha512 nach GPG-Prüfung der .asc (keine Werte aus dem Audit-Bericht), pkgutil --check-signature mit Team-ID, kein Verzeichnis-Scraping; Inno Setup per choco mit fester Version + Checksumme
- 18.11.2026 Wave 6: #211/#210 → wie in den Issues: Sprung vertikal zentriert für alle Sprung-Aufrufer (SyncTeX, Outline, Fehlerliste, Kommentare); Strg+Rad-Zoom um Mauszeiger, ~10 %/Raste, 25–300 %, entprellt; GUI-Abnahme als ⬜ in TODO.md
- 18.11.2026 Wave 6: #174 + #175 bewusst ein Agent (beide release.yml)
- 18.11.2026 Wave 7: #182 → Invite- + Share-Tokens nur gehasht (hashToken) + timingSafeEqual, bestehende Klartext-Tokens beim Laden einmalig hashen (alte Links gültig), Share-Links mit optionalem Ablaufdatum (Default ohne Ablauf); fester 30-Tage-Ablauf verworfen
- 18.11.2026 Wave 7: #180 → Setzen (register/reset/change/initial) lehnt >72 Byte UTF-8 mit klarer Meldung ab; Login nur grobe Obergrenze 1024 Zeichen (bestehende Konten nicht aussperren); SHA-256-Prehash verworfen (Hash-Versionierung + Migration)
- 18.11.2026 Wave 7: Zusammenstellung #178+#182, #179+#180, #184+#185, #209+#189; #183 nach #184 (Fehlermeldungs-Überschneidung)

## Wave 1 (18.11.2026)
| Issue | Prio | Agent | Status |
|---|---|---|---|
| #156 | 1 | agent-1 | DONE |
| #157 | 1 | agent-2 | DONE |
| #155 | 1 | agent-3 | DONE |
| #161 | 1 | agent-4 | DONE |

## Ausgeschlossen
- #121, #137, #199: PRs bereits auf master gemergt → nur Schließen offen

### Wave 1 Ergebnis
- Merges konfliktfrei: agent-1 e34286a, agent-2 4e7c37e, agent-3 9397b91, agent-4 e182cca
- Suite: 282 Tests, 279 pass, 2 fail (pandocCopyright CRLF, containerWorkflow Windows — beide vorbestehend auf master, nicht Wave-bezogen) → kein Revert
- Issues bleiben bis Merge nach master offen

## Wave 2 (18.11.2026)
| Issue | Prio | Agent | Status |
|---|---|---|---|
| #160 | 1 | agent-1 | DONE |
| #159 | 1 | agent-2 | DONE |
| #154 | 1 | agent-3 | DONE |
| #167 | 1 | agent-4 | DONE |
- Merges: agent-1 c0485d1, agent-4 b542f24 konfliktfrei; agent-2 + agent-3 erst Konflikt in test/sicherheit.test.js → Worker hat staging in seinen Branch gemergt, dann agent-2 28f63f6, agent-3 0ae8f9b
- Suite: 286 Tests, 283 pass, 2 fail (dieselben vorbestehenden: pandocCopyright CRLF, containerWorkflow Windows) → kein Revert

## Wave 3 (18.11.2026)
| Issue | Prio | Agent | Status |
|---|---|---|---|
| #153 | 1 | agent-1 | DONE |
| #165 | 1 | agent-2 | DONE |
| #166 | 1 | agent-3 | DONE |
| #170 | 1 | agent-4 | DONE |
- Merges konfliktfrei: agent-1 8e67d71, agent-2 e9b2a97, agent-3 9a12ceb, agent-4 7722d3e
- Erste Suite: neuer Fehler SPDX-Kopf in 2 neuen Testdateien → statt Revert Nachbesserung 21f8ce4 (nur Testdatei-Kopf)
- Suite: 294 Tests, 291 pass, 2 fail (dieselben vorbestehenden: pandocCopyright CRLF, containerWorkflow Windows) → kein Revert
- Zurückgestellt (Kollision mailer.js/auth.js): #169, #168

## Wave 4 (18.11.2026)
| Issue | Prio | Agent | Status |
|---|---|---|---|
| #169 | 1 | agent-1 | DONE |
| #168 | 1 | agent-2 | DONE |
| #163 | 1 | agent-3 | DONE |
| #158 | 1 | agent-4 | DONE |
- Merges: agent-2 bf9a0ee, agent-1 6cc88d9, agent-3 d6a9312 konfliktfrei; agent-4 erst Konflikt in server/index.js (CONFLICT_RETRY) → Worker hat staging in seinen Branch gemergt (24e4fa1), dann c3d786e
- Suite: 303 Tests, 299 pass, 2 skipped, 2 fail (dieselben vorbestehenden: pandocCopyright CRLF, containerWorkflow Windows) → kein Revert
- Offen aus #158: Quota bei geteilten Projekten zählt den Hochladenden statt den Eigentümer; Yjs-WS und /mcp ohne Free-Space-Prüfung
- Offen aus #163: PKCE-Tokenaustausch

## Wave 5 (18.11.2026)
| Issue | Prio | Agent | Status |
|---|---|---|---|
| #176 | 1 | agent-1 | DONE |
| #162 | 1 | agent-2 | DONE |
| #171 | 1 | agent-3 | DONE |
| #173 | 1 | agent-4 | DONE |
- Merges konfliktfrei: agent-2 766f1ba, agent-3 75e2d24, agent-4 ee359c5, agent-1 c70ac24
- agent-4: Scope-Erweiterung auf test/macRelease.test.js + test/p12restE.test.js (neue Job-Struktur)
- Suite: 342 Tests, 338 pass, 2 skipped, 2 fail (dieselben vorbestehenden: pandocCopyright CRLF, containerWorkflow Windows) → kein Revert; licenses-/LuaLaTeX-Fehler nur in Worktrees (Junction-Artefakt)
- Offen aus #162: Crash zwischen Eintrag und Manifest → Start-Abbruch; Rollback-Schutz nur manifest-intern
- Offen aus #176: mcp_auth_fail nur in mcpTokenFirst geloggt; GUI-Prüfpunkt ⬜ in TODO.md
- Zurückgestellt für Wave 6: #172 (server-update.sh, Kollision #171), #164 (MCP, Kollision #176), #174 + #175 (Workflows, Kollision #173; #174 braucht Signier-Zertifikate)

## Wave 6 (18.11.2026)
| Issue | Prio | Agent | Status |
|---|---|---|---|
| #172 | 1 | agent-1 | DONE (aca1979) |
| #164 | 1 | agent-2 | DONE (6574d2a) |
| #175, #174 | 1 | agent-3 | DONE (266eeda) |
| #211, #210 | 2 | agent-4 | DONE (78edd42) |

Wave-6-Tests: 362 Tests, 358 pass, 2 skipped, 2 fail (nur bekannte: pandocCopyright CRLF, containerWorkflow Windows). Offen für User: Secret RELEASE_SIGNING_KEY + Host-Datei .release-signers anlegen (#172, Anleitung docs/UPDATES.md); Workflows #174/#175 erst beim nächsten Release real geprüft; GUI-⬜ in TODO.md (#164, #210, #211).

## Wave 7 (18.11.2026)
| Issue | Prio | Agent | Status |
|---|---|---|---|
| #178, #182 | 2 | agent-1 | DONE (b73f11d) |
| #179, #180 | 2 | agent-2 | DONE (c636a68) |
| #184, #185 | 2 | agent-3 | DONE (f9d817d) |
| #209, #189 | 2 | agent-4 | DONE (c829413, TODO.md-Konflikt: beide Einträge behalten) |
Tests: 380 pass, 2 fail (bekannt: pandocCopyright, containerWorkflow)

## Wave 8 (21.11.2026)
| Issue | Prio | Agent | Status |
|---|---|---|---|
| #188, #183, #186 | 1 | agent-a | DONE (a931c85; #183 teilweise: share/join, Projektlisten, desktop.js offen) |
| #187 | 1 | agent-b | DONE (957b9a7) |
| #190, #191, #192, #200 | 2 | agent-c | DONE (8f098fe) |
| #181, #199, #200 | 2 | agent-d | DONE (c78db36; #200 Punkte 1/2/5, `reuse lint` nicht gelaufen) |
- Zurückgestellt: #212; #198/#193 = Übersichts-Issues
- Nachgezogen: #188-Test (Escape-Bug im TeX-String), test/_server.js stop() killt auf Windows den Prozessbaum (sonst überleben TeX-Enkel → EPERM)
- Befund: `child.kill()` des Servers auf Windows lässt laufende latexmk/pdflatex weiterlaufen (Exit-Handler laufen nicht); Compile-Timeout selbst killt den Baum korrekt
- Tests: 396, 392 pass, 2 skipped, 2 fail (bekannt: pandocCopyright, containerWorkflow)

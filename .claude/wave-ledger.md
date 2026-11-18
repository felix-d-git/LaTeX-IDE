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

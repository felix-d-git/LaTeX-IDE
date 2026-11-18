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
| #160 | 1 | agent-1 | IN_PROGRESS |
| #159 | 1 | agent-2 | IN_PROGRESS |
| #154 | 1 | agent-3 | IN_PROGRESS |
| #167 | 1 | agent-4 | IN_PROGRESS |

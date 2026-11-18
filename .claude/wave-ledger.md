# Wave-Ledger

Base: master (tabu) · Second: staging/second-branch

## Entscheidungen
- 18.11.2026 Wave 1: #155 → worker_threads-Timeout + Längenlimits + Rate-Limit, keine neue native Dependency (re2 verworfen)
- 18.11.2026 Wave 1: #157 → Reviewer dürfen nur `anchors` eigener Kommentar-IDs ändern; pending structs ablehnen; Token-Bucket ~20 Updates/s; kleinere maxPayload für Reviewer
- 18.11.2026 Wave 1: #161 → Punkt 3 (tmpfs-Reserve) ausgeklammert, gehört zu #158
- 18.11.2026: BASE_BRANCH = master (main existiert nicht)

## Wave 1 (18.11.2026)
| Issue | Prio | Agent | Status |
|---|---|---|---|
| #156 | 1 | agent-1 | IN_PROGRESS |
| #157 | 1 | agent-2 | IN_PROGRESS |
| #155 | 1 | agent-3 | IN_PROGRESS |
| #161 | 1 | agent-4 | IN_PROGRESS |

## Ausgeschlossen
- #121, #137, #199: PRs bereits auf master gemergt → nur Schließen offen

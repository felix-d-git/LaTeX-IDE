# MCP-Zugang

Die IDE ist ein MCP-Server (`POST /mcp`, Streamable HTTP, zustandslos). Externe KI-Tools (Claude Code, Codex, Cursor) arbeiten damit an deinen Projekten.

## Einrichten

1. Einstellungen → Reiter „MCP“ → Name, Rechte und Projekte wählen → „Token erstellen“.
2. Token (`lmcp_…`) sofort kopieren: er wird nur einmal angezeigt (gespeichert wird nur der Hash).
3. Endpunkt: `https://<server>/mcp`, Header `Authorization: Bearer <token>`.

Claude Code:

```
claude mcp add --transport http latex https://<server>/mcp --header "Authorization: Bearer <token>"
```

Codex (`~/.codex/config.toml`):

```toml
[mcp_servers.latex]
url = "https://<server>/mcp"
http_headers = { Authorization = "Bearer <token>" }
```

Der Reiter „MCP“ enthält einen fertigen Prompt, mit dem das Tool den Connector selbst einrichtet.

## Rechte

Jedes Token hat Einzelrechte, entweder für alle Projekte oder pro ausgewähltem Projekt. Änderungen gelten sofort, der Token bleibt gleich.

| Recht | Werkzeuge |
|---|---|
| `read` | `list_projects`, `project_tree`, `outline`, `read_file`, `search`, `get_errors` |
| `comment` | `add_comment`, `suggest_change` |
| `edit` | `edit_file` |
| `create` | `create_file` (Text oder base64) |
| `delete` | `delete_file` |
| `move` | `move_file` (umbenennen/verschieben) |
| `compile` | `compile`, `compile_status` |

- Nie mehr als dein eigener Zugriff: als Reviewer in einem Projekt höchstens `read` + `comment`.
- `tools/list` zeigt nur erlaubte Werkzeuge; Pfade außerhalb des Projekts werden abgelehnt.
- Dateiänderungen sind in offenen Editoren live sichtbar.

## Kompilieren

`compile` ist standardmäßig aus. Kompilieren ist langsam und belastet den Server – daher selten nutzen.

- `compile` startet asynchron und antwortet sofort mit Status und geschätzter Dauer (längster der letzten 5 Läufe, sonst Schätzung nach Projektgröße).
- `compile_status` liefert Fortschritt in % (höchstens 99 %, bis fertig) bzw. das Ergebnis und die Abweichung von der Schätzung.
- Pro Projekt läuft ein Job; ein zweiter Aufruf liefert den laufenden.

## Migration alter Tokens

`read` → `read`; `review` → `read`, `comment`; `edit` → `read`, `comment`, `edit`. `compile` war früher implizit und ist nach der Migration aus.

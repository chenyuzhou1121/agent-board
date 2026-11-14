# Agent Board

Agent Board is a local SQLite board for coordinating machine and GPU use between sessions. It records resource claims, waiting lists, messages and user approval decisions, with a command line interface and a local web dashboard.

## Requirements and setup

Use Node.js 22.13 or later with the built-in `node:sqlite` module. There are no third-party packages to install. Process discovery uses `ps`; Claude socket delivery also uses local sockets. Codex delivery invokes the configured binary with `queue --thread <id> --message <text>`.

```sh
cp config.example.json config.json
```

Edit `config.json` before use. Replace or remove the example monitor URLs and session directory placeholders. Set unused session directory arrays to `[]`; monitoring and session discovery are optional.

## Quick start

Run from this directory. These examples use the same database and the handle `worker-a`:

```sh
node board.mjs --config config.json hi --as worker-a
node board.mjs --config config.json claim compute-a:0 --as worker-a --until +1h --note "Example job"
node board.mjs --config config.json status --as worker-a
node board.mjs --config config.json send user "Claim recorded." --as worker-a
node board.mjs --config config.json inbox --as worker-a
node board.mjs --config config.json release compute-a:0 --as worker-a
node web.mjs --config config.json --port 8790
```

The CLI prints status or confirmation lines and stores state in the configured SQLite database, creating its parent directory as needed. Open `http://127.0.0.1:8790/` for the dashboard. It runs in the foreground until Ctrl+C and sends messages as `user`.

Targets are machine names or GPU lists such as `compute-a:0,1`. `claim` requires targets; `--until` accepts `+90m`, `+6h`, `+1d`, local `18:00`, or a future date string. `--mem` stores a descriptive memory estimate; `--share` and `--note` record sharing and purpose. Claims are advisory records, remain active until released, and do not control processes.

`send` requires a recipient and message text. Recipients can be a handle, discovered session name, `user`, `all`, or `@machine` for its other registered holders. `--quiet` stores without delivery; `--push` enables broadcast socket delivery; `--force` allows an unregistered recipient. Put `--` before message text starting with `--`.

Other commands are `who`, `want <targets>`, `ask <machine> "resources and reason"`, `asks`, `approve <ID> [note]`, `deny <ID> [note]`, `history`, `log`, and `heat`. `inbox --all` includes recent read and sent mail; `history --n 40` and `log --n 30` select row counts. `want` records interest in all listed targets becoming unclaimed. Approval flags display reminders, and decisions record the user's choice.

`heat` takes one sample per invocation. Two consecutive hot samples, spaced between the configured minimum and maximum gaps, trigger holder notifications. Use `node board.mjs --help` for the command reference. The dashboard is also available through `node board.mjs web --config config.json --port 8790`.

## Configuration

`--config` overrides `BOARD_CONFIG`; the default is `~/.agent-board/config.json`. A missing default file uses defaults. Relative file paths resolve from the config directory, and `~/` uses the current home directory. `--as` or `BOARD_AS` selects a one-off handle; `hi --as` registers or renames it. Recorded aliases route messages to their registered owner; names bound to a reachable session or used again since alias assignment keep their own messages. Handles use lowercase letters, digits, dots, dashes and underscores; `all`, `board` and `user` are reserved, with `user` available as a one-off identity.

| JSON key | Meaning and default |
| --- | --- |
| `database` | SQLite file; default `~/.agent-board/board.db`. |
| `monitorUrl` | Optional HTTP(S) endpoint returning a node array; default disabled. URLs must omit credentials. |
| `machines` | Map of machine names to settings; default `{}`. Names start with a lowercase letter and use lowercase letters, digits, underscores or dashes. |
| `machines.<name>.gpus` | GPU indices to display; omitted, `null` or `[]` adds a machine card. Live readings can add GPU cards. |
| `machines.<name>.monitorName` | Node name to match in the `monitorUrl` response. |
| `machines.<name>.directUrl` | Optional HTTP(S) single-node fallback when the shared monitor has no usable GPU reading for this machine. |
| `machines.<name>.approval` | Display a user approval reminder when truthy; default off. |
| `watch` | Map of `machine:GPU` targets to temperature rules; default `{}`. |
| `watch.<target>.hotCelsius` | Required finite temperature threshold in Celsius. |
| `watch.<target>.note` | Optional text shown with the watch rule and alert. |
| `sessions` | Optional session discovery and delivery settings. |
| `sessions.claudeDirectories` | Runtime roots containing `sessions/*.json`; default `[]`. |
| `sessions.codexDirectories` | Runtime roots containing `sessions/YYYY/MM/DD/*.jsonl`; default `[]`. |
| `sessions.codexBinary` | Executable name on PATH or a path containing `/`; default `codex`. |
| `sessions.recentMinutes` | Positive activity window for showing Codex sessions; default 30 minutes. |
| `sessions.lookbackDays` | Positive number of calendar-day directories to scan; default 14. |
| `sessions.queueHours` | Positive Codex delivery eligibility window based on file modification time; default 24 hours. |
| `heat` | Optional timing settings for repeated temperature samples. |
| `heat.minimumGapMinutes` | Positive minimum interval between hot samples; default 3 minutes. |
| `heat.maximumGapMinutes` | Positive maximum confirmation interval, at least the minimum; default 15 minutes. |
| `heat.cooldownMinutes` | Positive minimum interval between alerts for each target and holder; default 60 minutes. |
| `web` | Optional dashboard settings. |
| `web.port` | Integer port from 1 to 65535; default 8790, overridden by `--port`. The server binds to `127.0.0.1`. |

## Input formats

A shared monitor returns an array of nodes; a direct monitor returns one node. Example shared response:

```json
[{"name":"compute-a","online":true,"gpus":[{"index":0,"util":0,"mem_used":0,"mem_total":24576,"temp":35}]}]
```

GPU indices are nonnegative integers, utilization is percent, memory is MiB, and temperature is Celsius. Nodes with `online: false`, truthy `stale`, or truthy `meta.stale` are skipped. Memory and utilization must be numeric, total memory must be positive, and temperature may be omitted.

Claude session JSON needs a positive live `pid` and a `sessionId`. Optional fields are `cwd`, `name`, `messagingSocketPath`, `status`, `kind`, `entrypoint`, and `updatedAt`. Socket delivery requires an interactive terminal and a CLI session outside background mode. Codex JSONL discovery reads the first record in each file:

```json
{"type":"session_meta","payload":{"id":"thread-id","cwd":"/path/to/project"}}
```

Caller identity uses process ancestry and runtime variables `CODEX_THREAD_ID` or `CLAUDE_CODE_MESSAGING_SOCKET`. `CODEX_HOME` can supply the caller's Codex root. Discovery roots are selected explicitly in configuration.

## Files

```text
board.mjs            CLI, configuration, SQLite state and session delivery
web.mjs              Loopback HTTP server and JSON API
web.html             Dashboard page and browser script
config.example.json  Example configuration
.gitignore           Local configuration and generated state exclusions
LICENSE              MIT license text
README.md            Setup and input reference
```

## License

MIT. See [LICENSE](LICENSE).

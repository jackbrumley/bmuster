# SPEC-AGENT-LOGS: Agent and server logs, machine reports and read-only diagnostics access

**Status:** `IMPLEMENTED (pending release)` · approved 2026-11-09 (Jack: "go", then "build everything") · second version. Replaces the v0.3.1 on-demand 200-line pull (see "Version 1" at the end). See "As built" at the end.

## Problem

Diagnosing a machine needs its logs when something has gone wrong, which is exactly when the agent may be offline, restarting or crashing. Version 1 only pulled the agent's last 200 in-memory lines on request, stored nothing, and could only be read by a person in a browser. The development AI helping to build BMuster had no way to read logs or machine facts without the developer copying them by hand.

## Behaviour

### 1. The agent sends its logs all the time

- Every log record the agent's own code writes at `info` or above (the existing `OWN_TARGETS` filter: library records below `warn` never leave the logger) goes into a **ship queue** as well as the 200-line local-page buffer.
- Records carry: per-process `instance` (random UUID made at start), `seq` (1, 2, 3… within the instance), `at` (ms since epoch), `level`, `source` (`agent` | `helper` | `journal`), `target` (module path) and `text` (at most 4 KiB, cut with a marker).
- `helper` lines are the stderr of child helpers the agent starts (the Wayland user-session helper, desktop helpers, `gst-launch`), read line by line and tagged with the helper's name.
- `journal` lines: when a terminal, files or desktop session fails to start, the agent automatically runs the version 1 fixed journal query (its own units, last 15 minutes, no exec units, five-second deadline, bounded output) and ships the result. No other journal access.
- **Redaction** runs before a record enters the queue, with the version 1 redaction rules (credential values and authentication material).
- **Spool.** The queue is written to `<data>/logs/spool-<n>.jsonl` segments (256 KiB each, at most 5 MiB in total, oldest segment deleted first, files mode 0600). A deleted segment is reported once as a `dropped` record with the count.
- **Sending.** While the live socket is connected, the agent sends `log-batch { instance, records: [...] }` messages (at most 500 records or 128 KiB each). The server replies `log-ack { instance, seq }` once the batch is stored; acknowledged records are dropped from the spool. On reconnect the agent sends the backlog, oldest first. Each instance's records arrive in order.
- **Rate limit.** At most 3000 records per minute per machine reach the server; the agent counts the excess and sends one `dropped` record per minute instead.
- **Verbose for a while.** The server can send `log-level { level: 'debug', untilMs }` (at most 4 hours ahead) or `log-level { level: 'info' }`. Debug lowers only the agent's own targets; library targets stay at `warn`. The agent returns to `info` at `untilMs` and on every restart. The server re-sends an unexpired verbose setting when the agent reconnects.

### 2. The server keeps them

- Table `agent_log_records`, primary key `(machine_id, instance, seq)`, so a resent record is ignored. Columns as above plus `received_at`. Index on `(machine_id, at)`.
- Table `server_log_records`, primary key `(instance, seq)`: the server logger's own records at `info` and above, with `area` (sessions, relay, agents, updates, auth, …) and, where known, `machine_id`. The server logger keeps writing to stdout as now.
- **Retention:** 7 days, and at most 100 000 records per machine and 200 000 server records; pruned at start and every hour. Removed machines keep their records until they age out.
- Only admins can read them. Reading is audited with the source, filter and record count, never the contents.

### 3. Machine report

- The check-in inventory gains a `display` section (Linux; Windows reports `{ kind: 'windows', console }`):
  - seat0's active session from logind: `type` (x11, wayland, tty, none), `class` (user, greeter, lock-screen), `desktop` (`XDG_CURRENT_DESKTOP` of the session leader), `state`, `lockedHint`;
  - each `/sys/class/drm/card*`: driver, connected connectors with their modes, and whether it is a KMS device;
  - `/dev/uinput` present and the `uinput` module loaded; `nvidia_drm` `modeset` value when present;
  - `xdg-desktop-portal`, GStreamer and its `pipewiresrc` plugin present (file checks only);
  - kernel release, agent version and launcher version.
- Only regular files under `/sys`, `/proc` and fixed program paths are read; no device node is opened (the gpus.rs rule).
- It travels inside the existing hashed inventory, so it is sent only when it changes and needs no new table.

### 4. Reading them

- **Console.** Manage replaces the version 1 Refresh panel with a **Logs** panel: newest first, filters for level, source and time, a "Live" toggle that polls every five seconds with a cursor, **Copy shown** and **Download**. A **Verbose for 1 hour** button (admins) shows the remaining time and a Stop button. Overview gains a **Display** card from the machine report.
- **Diagnostics tokens.** Settings → Diagnostics tokens (admins only): create one with a name and an expiry of 1, 7, 30 or 90 days. The token (`bmd_` + 32 random bytes, base64url) is shown once; the server keeps only its SHA-256 hash. It is tied to the admin who made it and stops working if they are disabled or stop being an admin, when it expires or when it is revoked.
- A token is accepted only as `Authorization: Bearer` on these GET endpoints, built by a new `route.diagnostics(...)` guard, and nowhere else (no cookie, no WebSocket, no state-changing request):
  - `GET /api/diagnostics/machines`: id, name, OS, agent version, online, last seen.
  - `GET /api/diagnostics/machines/[id]/logs?since&until&level&source&cursor&limit` (limit at most 2000).
  - `GET /api/diagnostics/machines/[id]/report`: the latest inventory and status.
  - `GET /api/diagnostics/server/logs?since&until&level&area&cursor&limit`.
- Signed-in admins can call the same endpoints with their session cookie.
- Token creation and revocation are audited; use is recorded as `lastUsedAt` and audited at most once per token per hour.
- **For the developer.** `npm run diagnostics -- machines|logs <name-or-id>|report <name-or-id>|server` reads `BMUSTER_URL` and the token from `~/.config/bmuster/diagnostics-token` (mode 0600, outside the repository) and prints plain text.

## Security

This is security work: it widens the agent channel, stores machine data centrally and adds a new credential.

- Logs can reveal host names, user names and paths, so they are admin-only, bounded and expire.
- Diagnostics tokens are read-only by construction: the guard only exists on GET handlers in `/api/diagnostics`. They expire (at most 90 days), are revocable, are stored hashed and are never logged.
- The agent never ships terminal output, exec command text, shell history, file contents or clipboard text; the journal query stays fixed.
- A machine can only write records for itself: records arrive over its authenticated live socket and the server sets `machine_id` from the socket.
- Message sizes and rates are bounded at both ends.

## Acceptance criteria

| #    | Criterion                                                                                                                                          | Named test                                                   |
| :--- | :------------------------------------------------------------------------------------------------------------------------------------------------- | :----------------------------------------------------------- |
| AL1  | The agent queues its own `info`+ records with instance, seq and redaction; library records below `warn` never enter the queue.                     | Rust `logging::tests::ship_queue_takes_own_records_redacted` |
| AL2  | The spool survives a restart, caps at 5 MiB by deleting the oldest segment, and reports what it dropped.                                           | Rust `log_spool::tests::spool_bounds_and_reports_drops`      |
| AL3  | Batches are bounded, acknowledged records leave the spool, unacknowledged ones are resent in order after reconnect.                                | Rust `log_spool::tests::ack_and_resend_in_order`             |
| AL4  | Verbose mode lowers only own targets, ends at its deadline and on restart.                                                                         | Rust `logging::tests::verbose_window_ends`                   |
| AL5  | A session start failure ships the fixed journal query; helper stderr is shipped with the helper's name.                                            | Rust `diagnostics::tests::session_failure_ships_journal`     |
| AL6  | The server stores batches idempotently for the socket's machine only, acknowledges them and enforces sizes and rates.                              | `agent-logs.test.ts`                                         |
| AL7  | Retention prunes by age and by count per machine and for the server.                                                                               | `log-retention.test.ts`                                      |
| AL8  | The server logger stores its own records with area and machine where known.                                                                        | `server-logs.test.ts`                                        |
| AL9  | The machine report reads only regular files and parses logind, DRM, uinput, NVIDIA and portal facts.                                               | Rust `display_report::tests::report_from_fixture_tree`       |
| AL10 | Diagnostics tokens: shown once, stored hashed, expire, revoke, die with their admin, and are refused on every non-diagnostics route and on POST.   | `diagnostics-tokens.test.ts`, `guards.test.ts`               |
| AL11 | Diagnostics endpoints filter, page with a cursor, cap limits and audit reads without contents.                                                     | `diagnostics-api.test.ts`                                    |
| AL12 | Logs panel filters, follows live, copies and downloads; Verbose shows its countdown; Display card renders the report; phone width has no overflow. | `machine-logs.svelte.test.ts`, `display-card.svelte.test.ts` |
| AL13 | `npm run diagnostics` prints machines, logs and reports with a token file.                                                                         | `diagnostics-cli.test.ts`                                    |

## Schema and routes

- New tables `agent_log_records`, `server_log_records`, `diagnostics_tokens` (`id`, `name`, `token_hash`, `user_id`, `created_at`, `expires_at`, `revoked_at`, `last_used_at`, `last_audited_at`), and `machines.verbose_until` (nullable). Generated, additive migration.
- Live socket messages `log-batch`, `log-ack`, `log-level`; the version 1 `diagnostics-request` and `diagnostics` messages and `POST /api/machines/[id]/logs` are removed. An older agent shows "This agent is too old to send its logs; update it" in the Logs panel.
- Routes: `/api/diagnostics/**` (GET), `POST /api/machines/[id]/verbose`, `GET|POST /api/diagnostics-tokens`, `DELETE /api/diagnostics-tokens/[id]`.

## Version 1 (v0.3.1, replaced)

An admin-only `POST /api/machines/[id]/logs` asked the live agent for its 200-line buffer and, on Linux, a fixed 15-minute journal query. Nothing was stored. Its redaction rules and the fixed journal query carry over unchanged.

## As built (pending release)

Every acceptance criterion has a passing test with the name the spec gives: the six Rust tests in `logging`, `log_spool`, `diagnostics` and `display_report`, and `agent-logs.test.ts`, `log-retention.test.ts`, `server-logs.test.ts`, `diagnostics-tokens.test.ts`, `guards.test.ts` (the `diagnostics guard` block), `diagnostics-api.test.ts`, `machine-logs.svelte.test.ts`, `display-card.svelte.test.ts` and `diagnostics-cli.test.ts`. Where the build differs from the text above, or adds to it:

- **Wire shapes.** `log-batch { instance, records: [{ seq, at, level, source, target, text }] }`; `log-ack { instance, seq }`; `log-level { level: 'debug', untilMs } | { level: 'info' }`. The Rust types live in the new `protocol/src/logs.rs` and `protocol/src/display.rs`. `dropped` reports are ordinary `warn` records with the target `dropped`.
- **Agent pipeline.** The logger redacts (version 1 rules, line replaced whole), cuts to 4 KiB and queues every record it lets through (at most 5000 waiting, the excess counted); only `run` turns the queue on. A `log-spool` thread moves it into the spool every 250 ms. `acked.json` in the spool folder holds the first unacknowledged line, so acknowledged records are not resent after a restart. One batch is in flight at a time; an unacknowledged batch is resent after 30 seconds or on reconnect.
- **Rates, both ends.** Entry into the spool is limited to 3000 records a minute (excess reported once a minute). Sending is paced by a 3000-record bucket that refills at 3000 a minute, so a backlog drains at that rate. The server keeps the same bucket per machine in memory; a batch over it is neither stored nor acknowledged, and the agent sends it again later, so an agent that keeps to the rule loses nothing.
- **A spool that cannot be opened** (disk full, permissions) leaves the agent running without shipping, logged as an error in its own log.
- **Helper stderr.** The Wayland user-session helper (`wayland-helper`) and the files helper (`files-helper`) are shipped with their names. `gst-launch` runs inside the Wayland helper, so its lines arrive under `wayland-helper`. The Windows desktop helper keeps writing its own `desktop-helper.log` and is not shipped.
- **Journal on failure.** Triggered when a terminal, files or desktop session fails to start, when its session thread fails, and when a terminal exits non-zero within five seconds of starting (the exit 208 case). At most one query a minute; exec sessions never trigger it. The fixed query is unchanged from version 1.
- **Verbose.** `POST /api/machines/[id]/verbose` takes `{ kind: 'hour' } | { kind: 'stop' }`; the server keeps `machines.verbose_until` and re-sends it on every reconnect while it lasts. Audited as `agent-verbose-started` / `agent-verbose-stopped`.
- **Display report.** `LockedHint` is `unknown` unless logind's session file carries `LOCKED_HINT` (current systemd does not write it there; reading it needs D-Bus, which this does not use). `desktop` is the session leader's `XDG_CURRENT_DESKTOP`, else logind's `DESKTOP`. The launcher passes its version to the worker as `BMUSTER_AGENT_LAUNCHER_VERSION`. Windows reports `{ kind: 'windows', console }` with the console user; macOS `unsupported`. An agent from before this sends no report, which reads as `unreported`; the Logs panel uses that to say "This agent is too old to send its logs; update it".
- **Server log.** A new logger, `services/logs/server-log.ts`, writes to standard output (warnings and errors to standard error) and, from start-up, to `server_log_records`. The start-up, snapshot, update, email, socket-upgrade, readiness and error-handler messages now go through it, plus "Live socket opened/closed" per machine. The first-run setup code still prints to standard output only and is never stored, because it is a secret.
- **Reads.** Records come newest first by their own time. The cursor is opaque: `o-<at>-<rowid>` pages back, `n-<rowid>` follows records stored since a read, by arrival, so a backlog from an agent that was offline is not missed by Live. Limits above 2000 are capped, not refused. Each read is audited (`agent-logs-viewed`, `server-logs-viewed`) with source, level, since, until, record count and `via` (`console` or `token <name>`); Live's follow-up reads are not audited again. Logs of removed machines stay readable until they age out; their report is 404 like the rest of the console.
- **Tokens.** Settings → Diagnostics lists every admin's tokens (name, maker, dates, last use) and revokes with a confirmation. The guard judges a request with an `Authorization` header by the token alone, and answers 405 to anything but GET. Hygiene's `route-guard-required` refuses `route.diagnostics` outside GET handlers under `src/routes/api/diagnostics/`, with fixtures. The admin check is the access service's new `canReadDiagnostics`.
- **The CLI** also takes `--since 1h|30m|2d|<ISO>` (default 1h), `--until`, `--level`, `--source` / `--area`, `--limit` and `--cursor`; prints logs oldest first and the report as JSON. It refuses a token file readable by others.
- **Removed:** `POST /api/machines/[id]/logs`, the `diagnostics-request` / `diagnostics` messages (both ends), `services/agents/diagnostics.ts`, `schemas/agents/diagnostics.ts` and the Recent agent logs panel. The `agent-logs-viewed` audit kind is kept for existing entries and now reads "Read agent logs".
- **Not natively tested:** the agent's spool and shipping against a real server, the display report on real Fedora/Ubuntu machines (including an NVIDIA one), the journal query after a real exit 208 (version 1's AL7 is still outstanding and now covered by this pipeline), and the Windows display report. These need a release build on the Fedora test machine.

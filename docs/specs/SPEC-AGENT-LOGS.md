# SPEC-AGENT-LOGS: Agent and server logs, machine reports and read-only diagnostics access

**Status:** `APPROVED` 2026-11-09 (Jack: "go", then "build everything") · second version. Replaces the v0.3.1 on-demand 200-line pull (see "Version 1" at the end).

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

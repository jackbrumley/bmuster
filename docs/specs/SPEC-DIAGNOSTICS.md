# SPEC-DIAGNOSTICS: Self-checks, crash reports, session timelines and platform logs

**Status:** `APPROVED` 2026-11-09 (Jack: "add as much diagnostic as we need for linux windows and mac so as we can quickly develop and iterate new versions and diagnose and solve problems") · builds on SPEC-AGENT-LOGS (shipped logs, machine report, diagnostics tokens).

## Problem

Shipped logs (0.4.1) and SELinux facts (0.4.2) showed what failed on the Fedora laptop, but only after someone tried a session, and only as far as the agent happened to log. To iterate quickly, each new agent version must tell us straight away which of its capabilities work on each machine, and why not; a crash must leave a record; and a session must leave a timeline of what it did, not just "started" and "ended". Windows needs the same, from its own sources. macOS has no agent yet.

## 1. Self-checks

The agent runs a fixed set of **checks** that each try one capability for real, in a harmless way, and report `pass`, `fail` with the reason, or `not-applicable`. Each result has `id`, `title`, `status`, `detail` (at most 2 KiB), `durationMs` and `checkedAt`.

**When:** 60 s after every start (so every new version reports itself), every 6 hours, after a session fails to start, and when an admin clicks **Run checks** in Manage (live socket `run-checks`; the agent replies `checks` with the results). Each check has a 10-second deadline and the whole run 60 seconds; checks never prompt the person at the machine, never show anything on screen and never leave a unit, device or file behind.

**Linux checks:**

| id                 | What it does                                                                                                  |
| :----------------- | :------------------------------------------------------------------------------------------------------------ |
| `systemd-run`      | Runs `/bin/true` as a transient unit, the way terminal sessions do (no pty).                                  |
| `systemd-run-pipe` | Runs `/bin/cat` as a transient unit with `--pipe`, writes a line, reads it back (the helpers' path).          |
| `terminal-pty`     | Runs `/bin/true` as a transient unit with the terminal's `TTYPath` and `StandardInput=tty` on a fresh pty.    |
| `logind-seat`      | Reads seat0's active session, as the desktop follower does.                                                   |
| `kms-capture`      | Starts the console helper unit and asks it for the display list and one frame's size (pixels are discarded).  |
| `egl`              | Loads the EGL, GLES and GBM libraries and creates a context on each render node.                              |
| `uinput`           | Opens `/dev/uinput` and creates and destroys a device with no keys or buttons (it can never type or click).   |
| `x11-display`      | On an X11 screen: connects with the found Xauthority and reads the root window size.                          |
| `portal`           | On a Wayland desktop: checks the user's session bus has `org.freedesktop.portal.Desktop` (no portal session). |
| `journal`          | Runs the fixed journal query with `--lines=1`.                                                                |
| `audit`            | Runs the fixed audit query; `pass` with the denial count.                                                     |

**Windows checks:** `service-account` (runs as LocalSystem), `console-session` (`WTSGetActiveConsoleSessionId`, user name), `helper-launch` (starts the desktop helper in the console session with a `--check` argument that exits at once), `dxgi-duplication` (helper: opens Desktop Duplication on each output, one frame size), `gdi-capture` (helper), `send-input` (helper: `SendInput` with zero events), `sas-policy` (reads `SoftwareSASGeneration`), `event-log` (runs the fixed event-log query with one result).

**Results** are sent in the check-in (replacing the last set) and also shipped as one log record per failed check. Admins see them on a **Checks** card in Manage: a pass/fail list with details and a Run checks button. The diagnostics API adds `GET /api/diagnostics/machines/[id]/checks`, and `npm run diagnostics -- checks <machine>`.

## 2. Crash and exit reports

- The agent installs a panic hook that writes the panic message, location and a backtrace (`RUST_BACKTRACE` capture, at most 16 KiB) synchronously into the log spool as an `error` record before the process exits. It ships after the restart.
- The launcher records every worker exit: exit code or signal, uptime, and the last 20 log lines the worker wrote to stderr, as one `error` record (`source: agent`, target `launcher`), shipped by the next worker. A clean stop is `info`.
- Helpers (console, Wayland, Windows desktop) that exit unexpectedly report their exit status the same way.

## 3. Session timelines

- Each session (terminal, files, desktop, command) records its steps with times: ticket checked, unit or helper started, first byte or first frame, backend chosen (X11, KMS, portal, DXGI, GDI), screens found, each screen switch, input device created, ended and why. The agent ships the timeline as one `info` record with target `session-timeline` when the session ends, and a failure ships it at once.
- Desktop sessions also ship a `session-stats` record every 30 seconds: frames sent, average capture and encode milliseconds, bytes per second, dropped frames, tile count and the current backend.
- The server joins these to the session's own start and end events. Admins see a **Sessions** list in Manage with each session's timeline. The API adds `GET /api/diagnostics/machines/[id]/sessions?since&limit` and the CLI `sessions <machine>`.

## 4. Platform logs

- **Linux:** the fixed journal and audit queries (SPEC-AGENT-LOGS), plus the checks above.
- **Windows:** the desktop helper's log file is shipped with source `helper` (the 0.4.1 gap). On a failed session or check, one fixed Event Log query ships the last 15 minutes of System-log Service Control Manager events naming BMuster and Application-log errors from BMuster processes (`wevtutil qe` with a fixed XPath, at most 100 events, 5-second deadline). The Windows machine report gains: Windows build and edition, console session id and state, secure desktop active, each DXGI output (adapter, name, size, rotation) and the SAS policy value.
- **macOS:** BMuster has no macOS agent yet. When it gets one, its report carries Screen Recording and Accessibility permission states and ScreenCaptureKit availability, and its checks mirror the ones above. Nothing is built for macOS now.

## 5. Command line for development

`npm run diagnostics` gains `--since <10m|2h|ISO>`, `--level`, `--source`, `--follow` (poll every 3 s and print new records), `checks <machine>`, `sessions <machine>`, and `watch <machine>`, which follows logs, check results and the machine's online state together. Every command prints plain text, with `--json` for raw output.

## Security

This is security work: checks touch the agent channel, systemd, devices and helpers.

- Checks are fixed code paths. Nothing from the server or browser changes what they do; `run-checks` carries no arguments.
- The uinput check creates a device with no capabilities, so it cannot type or click. The KMS check discards pixels inside the helper and sends only the display list and sizes. No check captures screen content, keystrokes or files.
- Run checks is admin-only, rate limited to once a minute per machine and audited. Diagnostics tokens can read results but cannot run checks.
- Crash records go through the same redaction as other log records.

## Acceptance criteria

| #   | Criterion                                                                                                                                              | Named test                                                                  |
| :-- | :----------------------------------------------------------------------------------------------------------------------------------------------------- | :-------------------------------------------------------------------------- |
| D1  | The Linux check list runs every check with its deadline, reports pass, fail with reason, or not applicable, and leaves nothing behind.                 | Rust `checks::tests::linux_checks_report_each_status`                       |
| D2  | Checks run 60 s after start, every 6 h, after a failed session and on `run-checks`; never concurrently.                                                | Rust `checks::tests::schedule_and_triggers`                                 |
| D3  | The uinput check's device has no key or button capabilities; the KMS check sends no pixels.                                                            | Rust `checks::tests::checks_capture_and_inject_nothing`                     |
| D4  | Windows checks run through the helper's `--check` mode and report each status.                                                                         | Rust `checks::windows::tests::results_from_helper` (compiled on Windows CI) |
| D5  | A panic writes its message and backtrace into the spool before exit; it ships after restart.                                                           | Rust `logging::tests::panic_is_spooled_before_exit`                         |
| D6  | The launcher records worker exits with code or signal, uptime and its last stderr lines.                                                               | Rust `launcher::tests::worker_exit_is_recorded`                             |
| D7  | Session timelines record each step with times and ship at the end or at once on failure; desktop stats every 30 s.                                     | Rust `sessions::tests::timeline_records_steps`, `desktop_stats_interval`    |
| D8  | Windows: the helper log and the fixed Event Log query are shipped; the Windows report has its new fields.                                              | Rust `diagnostics::windows::tests::event_log_query_is_fixed`, protocol test |
| D9  | The server stores the latest check results, serves checks and sessions through the diagnostics API, and Run checks is admin-only, limited and audited. | `machine-checks.test.ts`, `diagnostics-api.test.ts`                         |
| D10 | Manage shows the Checks card and the Sessions list; phone width has no overflow.                                                                       | `machine-checks.svelte.test.ts`, `machine-sessions.svelte.test.ts`          |
| D11 | The CLI filters by time, level and source, follows, and prints checks, sessions and watch output.                                                      | `diagnostics-cli.test.ts`                                                   |

## Schema and routes

- `machine_checks` (`machine_id` primary key, `results` JSON, `checked_at`), generated and additive. Timelines and stats are ordinary `agent_log_records` with targets `session-timeline` and `session-stats`; the Sessions list reads them.
- Live socket: `run-checks` (server to agent, no fields), `checks` (agent to server, results). The check-in gains `checks`, which older agents leave out (`unreported`).
- Routes: `POST /api/machines/[id]/checks` (admin), `GET /api/diagnostics/machines/[id]/checks`, `GET /api/diagnostics/machines/[id]/sessions`.

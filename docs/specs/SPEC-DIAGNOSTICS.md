# SPEC-DIAGNOSTICS: Self-checks, crash reports, session timelines and platform logs

**Status:** `IMPLEMENTED (v0.4.3)` · approved 2026-11-09 (Jack: "add as much diagnostic as we need for linux windows and mac so as we can quickly develop and iterate new versions and diagnose and solve problems") · builds on SPEC-AGENT-LOGS (shipped logs, machine report, diagnostics tokens).

## Problem

Shipped logs (0.4.1) and SELinux facts (0.4.2) showed what failed on the Fedora laptop, but only after someone tried a session, and only as far as the agent happened to log. To iterate quickly, each new agent version must tell us straight away which of its capabilities work on each machine, and why not; a crash must leave a record; and a session must leave a timeline of what it did, not just "started" and "ended". Windows needs the same, from its own sources. macOS has no agent yet.

## 1. Self-checks

The agent runs a fixed set of **checks** that each try one capability for real, in a harmless way, and report `pass`, `fail` with the reason, or `not-applicable`. Each result has `id`, `title`, `status`, `detail` (at most 2 KiB), `durationMs` and `checkedAt`.

**When:** 60 s after every start (so every new version reports itself), every 6 hours, after a session fails to start, and when an admin clicks **Run checks** in Manage (live socket `run-checks`; the agent replies `checks` with the results). Each check has a 10-second deadline and the whole run 60 seconds; checks never prompt the person at the machine, never show anything on screen and never leave a unit, device or file behind.

**Linux checks:**

| id                  | What it does                                                                                                                                                                            |
| :------------------ | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `systemd-run`       | Runs `/bin/true` as a transient unit, the way terminal sessions do (no pty).                                                                                                            |
| `unit-connect-back` | Runs `/bin/cat` under `stdio-host` in a transient unit that connects back, passes the peer check and echoes a line (v0.4.4, SPEC-SESSION-UNITS Version 2; replaced `systemd-run-pipe`). |
| `pty-host`          | Runs `/bin/true` under `pty-host`, which makes the pty inside a terminal unit (v0.4.4; replaced `terminal-pty`).                                                                        |
| `logind-seat`       | Reads seat0's active session, as the desktop follower does.                                                                                                                             |
| `kms-capture`       | Starts the console helper unit and asks it for the display list and one frame's size (pixels are discarded).                                                                            |
| `egl`               | Loads the EGL, GLES and GBM libraries and creates a context on each render node.                                                                                                        |
| `uinput`            | Opens `/dev/uinput` and creates and destroys a device with no keys or buttons (it can never type or click).                                                                             |
| `x11-display`       | On an X11 screen: connects with the found Xauthority and reads the root window size.                                                                                                    |
| `portal`            | On a Wayland desktop: checks the user's session bus has `org.freedesktop.portal.Desktop` (no portal session).                                                                           |
| `tray`              | For each person at a graphical session: the autostart entry starts the current program, their tray helper runs, and their bus has a StatusNotifierWatcher (SPEC-TRAY-SESSIONS).         |
| `journal`           | Runs the fixed journal query with `--lines=1`.                                                                                                                                          |
| `audit`             | Runs the fixed audit query; `pass` with the denial count.                                                                                                                               |

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

Since 2026-11-12 (pending release): `--since` reads from that time forward, oldest first, page by page, and without it the newest records are read, paging back through the server's 7 days; HTTP failures in agent records are one short line and repeated records collapse into summaries. See SPEC-AGENT-LOGS "Quieter logs and reading the whole week" (AL14 to AL18).

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

## As built (v0.4.3)

Every acceptance criterion has a passing test with the name the table gives, except D4's Windows test, which is type- and lint-checked but not run (see below). Where the build differs from the text above, or adds to it:

- **Wire shapes** (`protocol/src/checks.rs`). A result is `{ id, title, status: 'pass' | 'fail' | 'not-applicable', detail, durationMs, checkedAt }` (unix ms). The check-in's `checks` is `{ kind: 'pending' }` until the first run, then `{ kind: 'results', results }`; the server reads a missing field as `unreported`, and a `pending` check-in never overwrites stored results. `run-checks` is `{ type: 'run-checks' }`; the agent answers `{ type: 'checks', results }` after every run while connected, not only after `run-checks`.
- **Schedule** (`checks/mod.rs`). One `checks` thread runs the list one check at a time (each on its own thread with its 10-second deadline, the run within 60 seconds); asks that arrive during a run are answered by it. A failed session asks for a run at most once in five minutes; an admin's ask always runs. A run with failures also ships the fixed journal and audit queries once (as a failed session does), until a run passes again. Each failed check is one `warn` record with target `checks`.
- **Linux checks** (`checks/linux.rs`), all in the spec's order (in v0.4.4 `systemd-run-pipe` and `terminal-pty` became `unit-connect-back` and `pty-host`, and `Io::Detached` and `unit_arguments_running` went; see SPEC-SESSION-UNITS Version 2):
  - `systemd-run` and `terminal-pty` follow the agent's session mode: with sessions in the agent's process they are `not-applicable`. They use `TransientUnit` as sessions do, named `bmuster-terminal-check-<8 hex>`, so the shipped journal query and the agent's start-up sweep cover them. `systemd-run` uses a new `Io::Detached` (no streams) so it tests the unit alone; `terminal-pty` is `Pty::spawn` on a fresh pty, exactly the terminal's path, and names exit 208 in its detail.
  - `systemd-run-pipe` runs `/bin/cat` in the console helper's own unit arguments (`unit_arguments_running`, `bmuster-console-check-<hex>`), writes a line and reads it back; its detail carries `systemd-run`'s stderr (where "Connection reset by peer" shows). The Wayland helper's unit differs only by `--uid` and its environment.
  - `systemd-run-pipe` and `kms-capture` are `not-applicable` when the agent is not root (a development run), so a check never asks polkit for a password.
  - `kms-capture` starts the real console helper and asks the new `frame-size` request: the helper captures one full frame and answers only its size. `egl` opens a `Gpu` on each `/dev/dri/renderD*` in the agent's own process (not inside the helper's unit), so it is independent of the pipe failure.
  - `uinput` makes only `UI_DEV_SETUP`, `UI_DEV_CREATE`, `UI_DEV_DESTROY` (`CheckRequest` has no capability variant); a missing `/dev/uinput` is a failure.
  - `portal` runs `busctl` as the session's user on their bus: `ListNames`, then `ListActivatableNames`.
  - `logind-seat` passes with "no active session" when nothing is on the screen.
- **Windows checks** (`checks/windows.rs`). `helper-launch` starts `desktop-helper --check <file>` in the console session (`--check` conflicts with `--pipe`/`--service-pid`); the helper runs DXGI duplication and GDI on every display (one frame's size), `SendInput` with no events, writes the three results to `<data>/checks/helper-<pid>.json` and exits; the service reads and deletes the file. `dxgi-duplication`, `gdi-capture` and `send-input` report that run (a result the helper left out is a failure). `service-account` checks the token's SID is LocalSystem; `sas-policy` fails when services may not send Ctrl+Alt+Del.
- **Crash records.** The panic hook writes each panic as `error` records (target `panic`; the message line and the backtrace, at most 16 KiB, split within the 4 KiB record limit) to `left-*.json` files in the spool folder, synchronously and around the running spool (which the panicking thread may hold). `Spool::open` takes them in at the next start. The launcher's worker-exit records (target `launcher`) use the same files. The Windows desktop helper's hook writes the same records as `error` lines into `desktop-helper.log`, which the service ships; the supervisor also logs the helper's exit code.
- **Worker exits.** The launcher now reads the worker's stderr (and passes each line on to its own, so the journal still has them) and keeps the last 20 lines. Exit 0, restart (4), update (5) and revoked (3) are `info`; any other code or a signal is `error`. The console and Wayland helpers log their exit status when they end by themselves, and add it to the session's timeline.
- **Timelines** (`timeline.rs`). A session's threads enter its timeline; steps are `ticket-checked`, `socket-open`, `placement` (the unit name), `started`, `first-byte` (a byte count, never content), `exited`, `helper-started`, `helper-exited`, `portal-started` / `portal-failed`, `screen-opened`, `screens`, `screen-switch`, `screen-state`, `first-frame`, `backend`, `error`, then `ended` or `failed`. At most 40 steps (the middle ones dropped and counted as `omitted`), details cut to 240 bytes and redacted one by one, the whole record within 4 KiB. A terminal that exits non-zero within five seconds ships its timeline at once as failed. On Windows the service ships the session's own timeline (kind `desktop`) and the helper ships its screen steps and figures as a second timeline with kind `desktop-helper`, through its log.
- **Figures.** `bmuster_desktop::run` hands over `Figures` every 30 s and whenever the capture path changes (new `Capturer::backend()`); the agent ships `session-stats` when anything was captured or a full interval passed. Dropped frames are capture ticks skipped because the viewer was behind (window full or stalled).
- **Windows logs.** The service follows `desktop-helper.log` from its end once a second (restarting at the top after rotation) and ships each line with source `helper`, target `desktop-helper`; `[session-timeline]` and `[session-stats]` lines become those records. The Event Log query is two fixed `wevtutil qe` XPath queries (System SCM events, Application level 1–2 errors, 15 minutes, newest first, 100 events, five seconds); the agent keeps only events whose text names BMuster (XPath cannot match event text). It runs after a failed session or check. The Windows report's `system` adds build (`CurrentBuild.UBR`), edition, console session id and state, every DXGI output and the SAS policy; **secure desktop is always `unknown`**, because the service in session 0 cannot read the console's input desktop.
- **Server, console and CLI.** `machine_checks` (migration `0014_machine_checks.sql`, one `CREATE TABLE`). Run checks: 404 unknown machine, 409 offline, 429 with the seconds left (the once-a-minute limit is in memory), audited as `agent-checks-requested`. Session audit entries now carry the session id (`detail.session`), which joins them to timelines; entries from before 0.4.3 cannot be joined. Sessions reads are audited (`agent-sessions-viewed`); checks reads are not, like report reads. The Sessions API defaults to the last 7 days and 20 sessions (at most 200) and keeps each session's last 10 figures. The CLI's `--json` on `--follow` and `watch` prints one JSON line per event.
- **Rollback.** `docs/server-update-compatibility.json` gives 0.4.3 `rollbackFrom: []`, not 0.4.1 and 0.4.2: the migration is additive, but the two new audit kinds make an older server's audit reads throw (`toRecord` refuses unknown kinds), so its Activity page would break after a rollback. Widening it is Jack's call.
- **Not natively tested:** every check against real systemd, logind, KMS, EGL, uinput, X11 and the portal (the unit tests cover the list, the statuses, deadlines, schedule, the uinput requests and the KMS `frame-size` exchange; the real checks need a root agent on the Fedora laptop, where `systemd-run-pipe` and `terminal-pty` should reproduce the two failures). All Windows code (checks, helper `--check`, Event Log, helper log, report fields, DXGI outputs) is checked only with `cargo clippy --target x86_64-pc-windows-gnu --all-targets -- -D warnings` (C dependencies stubbed, nothing linked) and its pure parts tested on Linux; `checks::windows::tests::results_from_helper` compiles but has not run. macOS: nothing built.

## Windows outputs from the console session

**Status:** `PENDING RELEASE` · approved 2026-11-12 (Jack: "go"), asked for 2026-11-12 after the Display card on a Windows 10 PC showed "Outputs: None found" (and "Secure desktop: Unknown") while desktop capture worked.

**This is security work.** It adds a second mode to the desktop helper that the LocalSystem service starts in the console session.

### Problem

`display_report::windows_system()` called `dxgi::outputs()` in the service, which runs in session 0. DXGI lists no outputs there, because the monitors belong to the console session, so the report always said "None found". `.unwrap_or_default()` also turned any DXGI error into the same empty list.

### Behaviour

1. **Read in the console session.** The service starts `bmuster-agent desktop-helper --outputs <file> --data-dir <data>` in the active console session, exactly as the checks start `--check` (same SYSTEM token from the session's `winlogon.exe`, same job, `CREATE_NO_WINDOW`). The helper makes itself DPI aware (so sizes are real pixels), lists every DXGI output of every adapter, writes `{ kind: 'read', list }` or `{ kind: 'failed', reason }` to `<data>\checks\outputs-<pid>.json` and exits. The service waits up to 10 s, reads and deletes the file.
2. **Never a silent empty list.** No console session, a helper that cannot start, does not answer in 10 s, exits non-zero, or writes something unreadable, and a DXGI error: each is `{ kind: 'failed', reason }` with the reason, logged once as a warning by the service.
3. **Inventory, not live.** One reading is kept while the console session stays the same, for an hour; a failed reading for five minutes. A new console session (sign-in at the console, fast user switching, a Remote Desktop takeover) reads again at once. A lock held during the read means two callers (the check-in and the local page) never start two helpers.
4. **Within the server's limits.** At most 32 outputs; adapter and output names cut to 255 characters; reasons to 500.
5. **Wire shape.** `system.outputs` is `{ kind: 'read', list } | { kind: 'failed', reason }`. Agents before this change send the bare list read in session 0; the server reads it as `{ kind: 'service-session', list }` (and stores that shape).
6. **Display card.** `read` with outputs: one row per output (unchanged); `read` with none: "Outputs: None found"; `failed`: "Outputs: Could not read: <reason>"; `service-session` with none: "Outputs: Not visible to this agent version; update it" (with outputs: one row each).
7. **Secure desktop stays `unknown`.** It has the same cause (session 0 cannot see the console's input desktop), but it is live state: a reading kept for an hour would be wrong most of the time, and reading it at every check-in would change the inventory hash, and so resend the whole inventory, at every lock and unlock. The helper's session timeline already records it during a session. Showing it live (presence, not inventory) is an open question below.

### Acceptance criteria

| #   | Criterion                                                                                                                                                  | Named test                                                                                           |
| :-- | :--------------------------------------------------------------------------------------------------------------------------------------------------------- | :--------------------------------------------------------------------------------------------------- |
| DW1 | The helper's file becomes the outputs: a list (at most 32, names within 255 characters), its failure reason (within 500), or a failure when it is garbled. | Rust `console_outputs::tests::helper_file_is_parsed`                                                 |
| DW2 | A reading is kept for an hour in the same console session, a failure for five minutes; a new console session reads again at once.                          | Rust `console_outputs::tests::outputs_are_cached`                                                    |
| DW3 | The outputs travel as `read` with a list or `failed` with a reason.                                                                                        | Rust protocol `tests::windows_outputs_say_why_they_are_missing`, `windows_report_has_its_new_fields` |
| DW4 | The server reads `read`, `failed` and an older agent's bare list (as `service-session`), and reads its stored shape back.                                  | `display-report.test.ts` "DW4: …"                                                                    |
| DW5 | The Display card says "Could not read: <reason>", "None found" or "Not visible to this agent version; update it" instead of an empty list.                 | `display-card.svelte.test.ts` "DW5: …"                                                               |

### Security notes

- The helper runs the same fixed program and token as the `--check` mode; `--outputs` takes only the file path the service chose inside the data folder (readable by SYSTEM and Administrators only). Nothing from the server or the browser reaches it.
- It reads output names, adapter names, sizes and rotation; it captures nothing.

### Open questions

1. Secure desktop: drop the row from the Display card, or show it live from the presence channel? → recommend **drop it from inventory and leave it to the session timeline**, unless someone needs it outside a session.

### As built

- `agent/crates/agent/src/console_outputs.rs`: the helper's side (`write_outputs`), the service's run (`console_outputs`, `run_helper`) and the pure parsing and cache (DW1, DW2).
- `agent/crates/agent/src/main.rs`: `desktop-helper --outputs <file>` (conflicts with `--pipe`, `--service-pid` and `--check`).
- `agent/crates/protocol/src/display.rs`: `DxgiOutputs`.
- `src/lib/schemas/agents/display-report.ts`, `src/lib/domain/machines/display-report.ts`: the union, the older bare list and the card's rows.
- **Only linted, not run on Windows.** The Win32 parts pass `cargo clippy --target x86_64-pc-windows-gnu --all-targets -- -D warnings`; the pure parts ran on Linux.
- **Release test on Windows 10:** (a) with someone signed in at the console, the Display card lists each monitor with its size within a check-in of the update; (b) at the sign-in screen the console session still exists, so the outputs still show; when the helper cannot run (for example its program blocked by policy), the card says "Could not read: …" with the reason; (c) plug in a second monitor and sign out and in: the new output shows; (d) the agent log has no more than one "Could not read the display outputs" warning per five minutes.

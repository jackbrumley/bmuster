# SPEC-COMMANDS: Run a command on many machines at once

**Status:** `IMPLEMENTED (v0.4.26)` · approved 2026-11-14 (Commands; no notice at the machine in v1; typed count above 10; output kept 30 days; offline machines skipped) · **Date:** 2026-11-14 · Design inputs: Jack's request (2026-11-14), SPEC-SESSIONS (the agent's `exec` purpose, built and tested but not yet used by the server), SPEC-MCP (draft: Claude's commands, approved by a person), SPEC-ACCESS (permissions, machine groups, rules).

> **Security work.** This feature runs commands as root or SYSTEM on many machines with one click. It changes the access model (a new permission), the session ticket the agent checks, and the audit log. Every check below is checked twice: by the server when the run starts, and by each agent from its own signed ticket.

## 1. How it works

Jack wants to restart the print spooler on every corporate laptop.

1. **Pick machines.** On **Machines**, he presses **Select**. Tick boxes appear on the table rows and cards. Above the list, a **Groups** chip row shows his machine groups (Corporate Computers, Corporate Laptops, Linux Web Servers…) and the usual filters (Windows, Linux, Online). He taps **Corporate Laptops**: the list narrows to that group, and a link reads **Select all 23**. He taps it, then unticks two laptops he does not want.
2. **Write the command.** A bar fixed to the bottom of the screen reads **21 selected · Run command**. The **Run command** screen lists the selection by operating system ("21 Windows") and asks for the command, the shell (PowerShell, with cmd as the other choice) and a time limit (60 s). If the selection mixes Windows and Linux, it shows one command box for each, so each machine gets a command its system can run.
3. **Review and confirm.** **Review** shows the exact command, the shell, the time limit and every machine by name, with any that will be skipped and why (offline, no permission, agent too old). He confirms in a dialog that names the count: "Run on 21 machines?". For more than 10 machines, he types the number before **Run** unlocks. If he signed in more than 10 minutes ago, he enters his password first.
4. **Watch the results.** The run page shows one row per machine, updating live: waiting, running, succeeded (exit 0), failed (exit code), timed out, offline, skipped. The top line counts them ("19 succeeded · 1 failed · 1 offline"). Tapping a row shows that machine's output. **Run again on failed and offline** starts a new run on just those, through the same review and confirmation.
5. **Come back later.** Runs live on the server. The **Commands** tab lists past runs (who, when, command, counts); each opens its results page. Closing the browser does not stop a run.

## 2. Problem

Looking after many machines means doing the same small job on each: restart a service, check a setting, clear a cache. Today that is one terminal per machine. The agent can already run one command with no input and send back its output (`exec`), but nothing in the console uses it.

## 3. Acceptance criteria

### Selecting

| #   | Criterion                                                                                                                                                                                                                                                                                        | Named test                            |
| :-- | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :------------------------------------ |
| C1  | **Select mode.** The Machines page has a **Select** button, shown only to people with `run-commands` on at least one machine. In select mode, each table row and card has a tick box (40 px target), and **Done** leaves select mode and clears the selection.                                   | `machines-select.svelte.test.ts` "C1" |
| C2  | **Group and filter chips.** Select mode shows a chip row: one chip per machine group the person can see (built-in "All machines" first), then Windows, Linux and Online. Chips narrow the list; group chips combine as "in any of these groups", and the system and Online chips narrow further. | `machines-select.svelte.test.ts` "C2" |
| C3  | **Select all matching.** When the list is narrowed, a link reads **Select all N** and ticks exactly the machines shown. Ticks made before a filter change stay ticked. The bottom bar always shows the full selected count, including ticked machines the current filter hides.                  | `machines-select.svelte.test.ts` "C3" |
| C4  | **Bottom bar.** With one or more machines ticked, a bar fixed to the bottom of the screen (safe-area inset, phone and desktop) shows "N selected", **Clear** and **Run command**.                                                                                                                | `machines-select.svelte.test.ts` "C4" |
| C5  | **Only permitted machines can be ticked.** A machine the person lacks `run-commands` on shows no tick box in select mode, and **Select all** skips it, saying so ("Select all 21 · 2 you cannot run commands on").                                                                               | `machines-select.svelte.test.ts` "C5" |

### Writing and confirming

| #   | Criterion                                                                                                                                                                                                                                                                                                         | Named test                        |
| :-- | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :-------------------------------- |
| C6  | **One command per system.** The Run command screen shows one command box per operating system in the selection (Windows: PowerShell or cmd; Linux: sh or bash), each with its machine count. A selection of one system shows one box.                                                                             | `run-command.svelte.test.ts` "C6" |
| C7  | **Limits.** A command is 1 to 8,000 characters with no NUL. The time limit is 5 s to 10 min (default 60 s). Output is capped at 1 MB per stream per machine and marked when cut off. The same zod schema checks the form and the server.                                                                          | `commands.schema.test.ts` "C7"    |
| C8  | **Review.** Review shows each command in full in a monospaced box, its shell, the time limit, every machine that will run it by name, and every machine that will be skipped with its reason (offline, no permission, agent too old). Nothing runs from the Run command screen itself.                            | `run-command.svelte.test.ts` "C8" |
| C9  | **Confirmation.** **Run** opens a `confirmAction` dialog naming the count and the command ("Run on 21 machines?"). For more than 10 machines, the dialog has a box where the count must be typed before **Run** unlocks.                                                                                          | `run-command.svelte.test.ts` "C9" |
| C10 | **Recent sign-in.** Starting a run needs a password check within the last 10 minutes (or a fresh single sign-on). Otherwise the dialog asks for the password first. A wrong password counts toward the normal sign-in failure limits. (New: BMuster has no recent-sign-in check yet; it is built here for reuse.) | `commands-service.test.ts` "C10"  |

### Running

| #   | Criterion                                                                                                                                                                                                                                                                                                                             | Named test                                                     |
| :-- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | :------------------------------------------------------------- |
| C11 | **New permission `run-commands`.** Added to SPEC-ACCESS's list, labelled "Run commands", not included by any other permission (not even `terminal`). Admins have it on every machine, as they have every permission; nobody else has it until a rule gives it.                                                                        | `access.test.ts` "C11"                                         |
| C12 | **Server checks every machine at the start.** The server rechecks `run-commands` for each machine when the run starts, with the access service. A selection containing a machine the person may not run on is refused whole with the machine names, never trimmed quietly.                                                            | `commands-service.test.ts` "C12"                               |
| C13 | **One signed ticket per machine.** Each machine gets its own `exec` ticket naming that machine, the person, the exact command, shell, time limit and output cap, and the permissions the person holds there. The agent runs only a ticket that carries `run-commands` (agent check), and refuses one whose machine id is not its own. | Rust `exec_needs_run_commands`; `session-ticket.test.ts` "C13" |
| C14 | **At most 10 at once.** A run starts at most 10 machines at a time and starts the next as each finishes, so a bad command does not hit every machine in the same second. Rows wait as "Waiting" until their turn.                                                                                                                     | `commands-service.test.ts` "C14"                               |
| C15 | **Offline and old agents are skipped, not queued.** A machine offline when its turn comes is marked "Offline" and nothing is sent. An agent older than the first version that accepts `run-commands` is marked "Agent too old (update first)".                                                                                        | `commands-service.test.ts` "C15"                               |
| C16 | **Results.** Each machine's row ends as succeeded (exit 0), failed (exit code), timed out, offline, skipped, or lost (the agent disconnected mid-run). The page updates live and survives a reload. Output is kept for 30 days, then deleted; the row and exit code stay.                                                             | `commands-service.test.ts` "C16"                               |
| C17 | **Cancel.** **Cancel run** (with `confirmAction`) stops machines that have not started. Machines already running finish or reach their time limit; there is no kill mid-command in v1.                                                                                                                                                | `commands-service.test.ts` "C17"                               |
| C18 | **Run again.** **Run again on failed and offline** opens the Run command screen with those machines and the same commands filled in, and goes through review, confirmation and the recent sign-in check again.                                                                                                                        | `run-results.svelte.test.ts` "C18"                             |

### Record and console

| #   | Criterion                                                                                                                                                                                                                                                    | Named test                             |
| :-- | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :------------------------------------- |
| C19 | **Audit.** Activity records the run start (who, command per system, machine count, skipped count), each machine's result (exit code, duration, output size and SHA-256), any cancel, and the end with its totals.                                            | `commands-service.test.ts` "C19"       |
| C20 | **Commands tab.** A console tab, **Commands**, lists runs newest first (who, when, the command's first line, counts), visible to people with `run-commands` on any machine. Each opens its results page. A person sees runs only for machines they can view. | `commands-page.svelte.test.ts` "C20"   |
| C21 | **Phone.** Select mode, the bottom bar, the Run command screen, review and results work at 360 px with no sideways scroll, in light and dark themes.                                                                                                         | `phone-overflow*.svelte.test.ts` "C21" |

## 4. Schema (additive)

- `command_runs`: `id`, `startedBy` (user), `startedAt`, `endedAt` (nullable), `status` (`running` | `finished` | `cancelled`), `timeoutMs`, `rerunOf` (nullable run id).
- `command_run_scripts`: `runId`, `osFamily` (`windows` | `linux`), `shell`, `command`. One row per system in the run.
- `command_run_machines`: `runId`, `machineId`, `status` (`waiting` | `running` | `succeeded` | `failed` | `timed-out` | `offline` | `skipped` | `lost` | `cancelled`), `skipReason` (nullable), `exitCode`, `startedAt`, `endedAt`, `durationMs`, `stdout`, `stderr` (text, capped, nulled after 30 days), `stdoutTruncated`, `stderrTruncated`, `outputSha256`.
- Permission list gains `run-commands` (stored inside rules' JSON, no column change).

## 5. Routes

- `POST /api/commands/runs` (`route.user`): `{ machineIds, scripts: [{ osFamily, shell, command }], timeoutMs, confirmCount, password? }` → `{ runId }`. Validates with the shared zod schema, checks recent sign-in, permissions and `confirmCount === machineIds.length` when more than 10.
- `GET /api/commands/runs` and `GET /api/commands/runs/[id=uuid]`: list and one run; machines filtered by `view`.
- `POST /api/commands/runs/[id=uuid]/cancel`.
- `GET /api/commands/runs/[id=uuid]/events`: live row updates as server-sent events, the same way `/api/machines/events` streams presence.
- Pages: `(console)/commands/+page.svelte` (runs), `(console)/commands/new/+page.svelte` (Run command and Review; the selection arrives as machine ids in page state, never trusted: the server rechecks), `(console)/commands/[id=uuid]/+page.svelte` (results).

## 6. Agent

- `SessionPurpose::Exec` requires `run-commands` instead of `ai-commands` (`required_permission`). SPEC-MCP, when built, uses the same `exec` purpose with its own approval step on the server and a ticket that names the person who approved; whether Claude's runs also need a separate `ai-commands` permission is settled in SPEC-MCP.
- No other agent change: `exec/pipe.rs` already runs one command with no input, separate stdout and stderr, a time limit and an output cap.

## 7. Security notes

- **Biggest risk: one click changes many machines.** Answered by the separate permission (C11), the review screen (C8), the typed count (C9), the recent password check (C10), the pace limit (C14) and the audit (C19).
- **No widening on the way.** The agent checks its own ticket: the machine id, the exact command, and `run-commands`. A server bug cannot make one ticket run on two machines or run a different command.
- **No silent trimming.** A selection that includes a forbidden machine is refused whole (C12), so a person never thinks a command ran everywhere when it did not.
- **Output can hold secrets.** It is shown only to people who can view that machine, kept 30 days, and only its size and hash go in the audit log.
- **The person at the machine is not told** in v1. Commands run as root or SYSTEM in the background, like the terminal. Open question 2.

## 8. Out of scope for v1

Saved commands (a library), schedules, queueing for offline machines, killing a running command, running as the signed-in user, file uploads with a command, approval by a second person, and Claude's commands (SPEC-MCP).

## 9. Open questions

1. **Tab name:** Commands (recommended), Actions or Automations. Automations fits schedules better and could come later.
2. **Tell the person at the machine?** A short tray notice ("An administrator ran a command") per run. Recommended: no for v1, matching the terminal; revisit with the Allow / Deny prompt work.
3. **Typed count threshold:** more than 10 machines (recommended), or every run on more than one machine.
4. **Output retention:** 30 days (recommended), or a setting.

## 10. As built

Where the build differs from the sections above, or settles something they left open.

- **Output cap.** The agent's `maxOutputBytes` counts stdout and stderr together, so each ticket asks for 2 MB and the server keeps at most 1 MB of each stream, marking a stream cut off when it passed 1 MB. When the agent itself reports `truncated` (both streams together passed 2 MB), both streams are marked cut off, since the agent does not say which one lost bytes. `outputSha256` is the SHA-256 of the kept stdout bytes followed by the kept stderr bytes.
- **Agent version.** "Too old" means older than `0.4.26-0`, so this release's own test and development builds (`0.4.26-…`) run commands; anything from 0.4.25 or before is skipped as "Agent too old (update first)". A development agent built before the version bump reports 0.4.25 and is skipped too.
- **macOS.** macOS machines are skipped as "Commands run on Windows and Linux only" (the spec covers Windows and Linux shells only).
- **Offline.** Offline machines wait their turn in the run (status `waiting`) and are marked `offline` only when their turn comes and they are still offline (C15). Review lists them as skipped (offline) because that is what happens if nothing changes.
- **Rechecked at each turn.** Besides the check at the start (C12), each machine is checked again when its turn comes: removed machine, disabled owner, or `run-commands` taken away since → `skipped` with that reason. The ticket carries the permissions the person holds at that moment.
- **Machines without permission on Review.** Review lists them as skipped ("You cannot run commands on it") and the console leaves them out of the request; a request that still names one is refused whole by the server (C12).
- **Typed count.** The server requires `confirmCount` to equal the machine count on every run, not only above 10; the console sends it, and only asks the person to type it above 10.
- **Who may cancel.** The person who started the run, or an admin.
- **Failed vs lost.** An agent that refused the ticket or could not start the shell gives `failed` with no exit code and the agent's message as the reason. `lost` covers the agent's socket closing mid-run and a command that went 30 seconds past its time limit without an answer. A timed-out command has no exit code.
- **Restart.** Runs live in the server's memory. At start-up a run the restart cut off is closed: machines that were running become `lost`, waiting ones `skipped` ("The server restarted before its turn").
- **Recent sign-in (C10).** Built in the auth area for reuse (`services/auth/recent-sign-in.ts`): the console session's `created_at` (the sign-in) or a new additive `reconfirmed_at` column (the last password check in that session) must be within 10 minutes. A wrong password is recorded as `sign-in-failed` (method "password check") and counts toward the per-email and per-address pauses; a right one clears that email's failures and is audited as `password-confirmed`. Someone with no password (provider sign-in only) is asked to sign out and sign in again.
- **Group chips for members (C2).** Admins see every machine group. Members do not see the Groups page, so they see only the machine groups named by their own rules that give `run-commands`, each listing only machines they can see.
- **Routes added.** `POST /api/commands/plan` (what Review shows, and whether the password is needed; runs nothing) and `GET /api/commands/runs/<id>/machines/<machineId>` (one machine's output, for people who can view that machine). Output is never in a list or an event.
- **Schema.** `command_run_machines` also has `position` (start order), `session_id` (joins the row to the agent's timeline), `output_bytes` and `output_deleted_at`; `skip_reason` also holds why a machine failed to run or was lost.
- **Audit kinds.** `command-run-started`, `command-run-machine` (one per machine, including skipped and offline ones), `command-run-cancelled`, `command-run-ended` and `password-confirmed`. A run's exec sessions are not also logged as `session-opened` / `session-ended`; the per-machine entry names the session.
- **Sessions.** A run's exec sessions use the relay with the server as their other end (like Files). They do not count toward the 10 sessions a person may have open, and they show as "command by <name>" in a machine's "In use".
- **Retention.** Output older than 30 days is deleted at start-up and every hour (beside the log retention, in its own schedule).
- **Tests.** C7 is in `commands-schema.test.ts` (kebab-case file names). C13's Rust tests are `exec_needs_run_commands` and `exec_ticket_for_another_machine_is_refused` (`agent/crates/protocol/src/session.rs`); the shared exec ticket vector was re-signed with `run-commands` and the 2 MB cap. C11 is in `services/access/access.test.ts`, C16's live updates and C18 in `commands/[id=uuid]/run-results.svelte.test.ts`, C20 in `commands/commands-page.svelte.test.ts`, C21 in `phone-overflow.svelte.test.ts`.

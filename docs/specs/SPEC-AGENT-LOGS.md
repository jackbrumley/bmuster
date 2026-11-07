# SPEC-AGENT-LOGS: Recent diagnostics in Manage

**Status:** DRAFT · 2026-11-08 · requested during the first Fedora test.

## Problem

A machine can enrol and report inventory while terminal, desktop or file sessions fail. Administrators need recent agent diagnostics in the main console, with a quick way to copy them into a bug report. The local page already has an in-memory buffer of 200 agent log lines, but the portal cannot request it. On Fedora a terminal exited with 208; the underlying systemd failure may appear only in the journal.

## Proposed behaviour

Manage gets a **Recent agent logs** panel with **Refresh**, **Copy all** and **Download text**. Nothing is fetched until requested. Show machine name, agent version, source, time fetched and any truncation. Render logs as selectable plain text in a bounded scrolling area. A failed refresh preserves the previous result, clearly labelled as old; an offline machine cannot supply fresh logs.

The first version returns the agent's current 200-line buffer. On Linux it also offers **Session startup diagnostics**, a bounded journal query for the agent service and its terminal/files services over the last 15 minutes. This is a fixed diagnostic operation, not an arbitrary command or arbitrary file reader. No shell history, terminal output or exec command contents are collected. Missing journal permissions or a timeout show the real reason for that source.

## Security and transport

This is security work because logs may reveal machine details and this extends the agent channel.

- Admins only, checked through the access service and the existing admin route guard. Unknown/removed machines are refused.
- An authenticated, origin-checked POST creates a random request id; the server sends a bounded `logs-request` over the machine's authenticated live socket.
- Only that same machine can satisfy its pending request. Unknown ids and unsolicited replies are refused. Replies are validated and capped at 256 KiB; requests time out after 10 seconds and are rate limited per user and machine.
- Return logs only to the requesting admin, with `Cache-Control: no-store`. No central database log archive in this version. Viewing is audited with source and line count, never the log contents.
- Redact known credential values and authentication material before returning logs. Unit journal queries exclude exec sessions, which can contain command arguments. No browser-provided journal flags, file paths or command strings.
- The Linux diagnostic subprocess has a five-second deadline, bounded output and no interactive input. Do not remove SELinux or service sandbox checks to collect logs.
- Older agents show a clear unsupported/timeout message, not a successful empty log.

## Acceptance criteria

| #   | Criterion                                                                                                                         | Named test                                        |
| :-- | :-------------------------------------------------------------------------------------------------------------------------------- | :------------------------------------------------ |
| AL1 | An admin requests recent logs only for a real, non-removed machine; members and signed-out callers are refused.                   | `agent-logs.test.ts`, `guards.test.ts`            |
| AL2 | A reply must match the pending request and authenticated machine; timeout, disconnect, unknown id and size limits are enforced.   | `agent-logs.test.ts`                              |
| AL3 | Agent returns timestamped buffer lines with explicit truncation and version; known credentials never appear.                      | Rust `logging::diagnostics_tests`                 |
| AL4 | Linux query is fixed, excludes exec commands, times out and bounds output; unavailable sources give a typed error.                | Rust `diagnostics::journal_tests`                 |
| AL5 | Panel refreshes, preserves labelled old data on failure, copies all lines and downloads plain text. Phone layout has no overflow. | `agent-logs.svelte.test.ts`, browser smoke test   |
| AL6 | Requests are audited without log contents; output is never rendered as HTML.                                                      | `agent-logs.test.ts`, `agent-logs.svelte.test.ts` |
| AL7 | A scratch agent's deliberately failed terminal startup is visible and can be copied from Manage.                                  | scratch-server/agent integration test             |

## Schema and routes

No new database schema. Add `POST /api/machines/[id]/logs` and bounded request/reply messages on the live agent channel. Reuse the existing log buffer and clipboard helper. Add an access-service capability for administrator diagnostic reads and an audit kind for fetching diagnostics.

## Open decision

Approve this scope, including fixed Linux session-start diagnostics alongside the existing recent-log buffer. This requires an agent update; rebuilding the signed local release is part of completion.

# SPEC-SESSIONS: Terminal sessions (first remote session type)

**Status:** `APPROVED` (2026-11-07, stretch goal of the first long batch) · Desktop and file sessions follow in later specs and reuse this relay.

## 1. Problem

BMuster can see machines but cannot do anything on them. A terminal is the cheapest real remote-control feature and proves the session path: browser ⇄ server relay ⇄ agent, with server-signed tickets the agent checks.

## 2. Acceptance criteria

| #   | Criterion                                                                                                                                                                                                                                                                                                                                                                                               | Test                                           |
| :-- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | :--------------------------------------------- |
| T1  | The machine's Terminal tab opens a real shell: Linux and macOS the root user's login shell (`/bin/bash` if present, else `/bin/sh`), Windows PowerShell (or `cmd` when chosen). Shown with xterm.js, resizing with the window.                                                                                                                                                                          | `terminal.svelte.test.ts`, agent `pty` tests   |
| T2  | Who may: admins always; members with the `terminal` permission (SPEC-ACCESS) when it exists. Otherwise the tab says why.                                                                                                                                                                                                                                                                                | `sessions.test.ts`                             |
| T3  | Opening a session: the browser asks the server (`POST /api/machines/[id]/sessions`), the server checks access and sends the agent `session-open` over its live socket with a **ticket signed by the server's key** (session id, machine id, kind `terminal`, permissions, user, expiry 60 s). The agent verifies the signature against the server key it stored at enrolment and refuses anything else. | `session-ticket.test.ts`, agent `ticket` tests |
| T4  | The agent opens its own WebSocket for the session (`/agent/v1/sessions/[id]`, signed like other agent requests); the browser connects to `/api/sessions/[id]/socket` with a short-lived browser ticket. The server relays bytes between the two without reading them as commands. A busy session never blocks the agent's control socket.                                                               | `relay.test.ts`                                |
| T5  | Mobile: a row of extra keys (Esc, Tab, Ctrl, Alt, arrows, pipe, tilde, slash) sends the right sequences; Ctrl and Alt act on the next key.                                                                                                                                                                                                                                                              | `terminal.svelte.test.ts`                      |
| T6  | Closing the tab, leaving the page or the shell exiting ends the session; the agent kills the shell's process group. A session with no browser for 60 s ends.                                                                                                                                                                                                                                            | `sessions.test.ts`, agent tests                |
| T7  | Each session is audited: opened (who, machine, shell), closed (duration, how it ended). No terminal contents are stored in this version.                                                                                                                                                                                                                                                                | `audit.test.ts`                                |
| T8  | The machine's Overview and Machines list show a small "In use: terminal by <name>" while a session is open.                                                                                                                                                                                                                                                                                             | `machine-views.test.ts`                        |

## 3. Agent

- Linux/macOS: a PTY (`openpty` / `forkpty` via `libc`, or the `portable-pty` crate, pinned) running the shell as root with `TERM=xterm-256color`; resize via `TIOCSWINSZ`.
- Windows: ConPTY (`CreatePseudoConsole`) via the `windows` crate or `portable-pty`; checked with the Windows clippy target.
- Messages on the session socket: binary frames are terminal bytes; text frames are JSON control (`resize`, `exit`).

## 4. Later

Consent prompts and the on-screen notice arrive with desktop sessions; the exec action for MCP reuses the ticket and relay.

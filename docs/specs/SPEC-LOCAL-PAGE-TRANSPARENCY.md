# SPEC-LOCAL-PAGE-TRANSPARENCY: Who manages this computer, and how to remove BMuster

**Status:** `IMPLEMENTED (v0.4.17)` · Approved by Jack, 2026-11-11. Extends SPEC-AGENT-LOCAL.

**This is security work.** It changes what the agent's local page shows before sign-in, and it adds a signed request the agent sends when an administrator uninstalls it at the machine. No check is weakened: the page still needs a code for every change, and the new request is checked like every other agent request.

## Problem

The local page (`https://localhost:47500`) showed only a code form before sign-in. Someone at the computer could not see who manages it, what that organisation can do, whether anyone is connected, or how to get rid of BMuster without a code. Jack: "if someone has admin privilege and wants to get rid of it they should have the ability to do that from that screen ... I'd feel more comfortable as a system admin if I knew I could just remove it with one command running as a machine admin."

Uninstalling with `bmuster-agent uninstall --purge` also left no trace on the server: the machine just went offline. Only the local page's own Uninstall told the server.

## Behaviour

1. **Name.** The page header and `<title>` say "BMuster Agent". The product name is capitalised wherever it is shown as a name (CLI `--help`, the install page heading, the join page, the copied log header, the installer scripts' first line, the page certificate's name). Ordinary sentences keep "the agent".
2. **Who is visiting.** A visitor is _at this computer_ when the connection comes from a loopback address (127.0.0.0/8 or ::1, also IPv4-mapped) **and** the browser asked for a loopback name (`localhost`, `127.0.0.1` or `[::1]` with the page's port). Everyone else is _from the network_ (the page is open to the network only with `local-page.json`).
3. **Before sign-in, at this computer**, in this order:
   1. _Who manages this computer:_ "This computer is managed by {server host name} with BMuster", the server address it is enrolled with, this computer's name (the console's name, or the host name before the first check-in) and the agent version. The agent is not told the organisation's name, so the server's host name stands in for it.
   2. _What BMuster can do here:_ people the server gives access can see and control the screen, open a terminal with administrator rights, and move files. The notice line follows the last desktop ticket's `notice` flag: shown, turned off by the server's settings, or (no desktop session since the agent started) what the agent does when the setting asks for it.
   3. _Right now:_ the people with a session open, by kind (Desktop, Terminal, Files, Command), from the agent's own session registry; or "Nobody is connected right now."
   4. _Remove BMuster:_ the one-line command for this operating system, and "No BMuster code is needed. Administrator rights on this computer are enough."
   5. _Sign in on {host} to make changes:_ the existing code form. A wrong code's message sits above the form.
4. **Before sign-in, from the network:** only _Remove BMuster_ and the sign-in form. No organisation, server, computer name or people.
5. **The commands** (one source: `agent/crates/agent/src/removal.rs` on the agent, `purge` in `src/lib/domain/machines/agent-commands.ts` on the console; a Rust test keeps them byte-for-byte equal):
   - Linux, in a terminal: `sudo /opt/bmuster/versions/current/bmuster-agent uninstall --purge`
   - Windows, in PowerShell as administrator: `& "$env:ProgramFiles\BMuster\bmuster-agent.exe" uninstall --purge`
6. **Local uninstall is recorded.** `bmuster-agent uninstall --purge` checks for administrator rights, then sends a signed `POST /agent/v1/leave` with reason `removed-at-machine`, waits at most 5 seconds, and uninstalls whatever the answer. The server marks the machine removed (the existing `removedAt`, no new state) and records `machine-removed-at-machine`; Activity reads "BMuster was removed from {machine} at the machine by a local administrator". `uninstall` without `--purge` keeps the identity for a reinstall, so it does not tell the server. The local page's own Uninstall is unchanged: it already records "Uninstalled the agent on {machine} from the local page (signed in with {whose} code)" and leaves with reason `uninstalled`; the `uninstall --purge` it schedules then finds the machine already removed (`revoked`), which counts as told.

## Acceptance criteria

| ID  | Behaviour                                                                                                                                   | Named test                                                                                                                                                                                      |
| :-- | :------------------------------------------------------------------------------------------------------------------------------------------ | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T1  | Header and title say "BMuster Agent"; at this computer the page shows who manages it, what BMuster can do, right now, remove, then sign-in. | Rust `local_page::about::tests::a_visitor_at_this_computer_sees_who_manages_it_and_how_to_remove_it`                                                                                            |
| T2  | From the network the page shows only the remove card and the sign-in form, also after a wrong code.                                         | Rust `local_page::about::tests::a_visitor_from_the_network_sees_only_removal_and_sign_in`, `local_page::routes::tests::before_sign_in_the_network_sees_only_removal_and_sign_in`                |
| T3  | Open sessions are listed by kind with the people's names (escaped); the notice line follows the server's setting.                           | Rust `local_page::about::tests::who_is_connected_is_listed_by_kind`, `local_page::routes::tests::before_sign_in_this_computer_sees_who_manages_it_and_who_is_connected`                         |
| T4  | Only a loopback peer asking for a loopback name is at this computer; IPv4-mapped loopback counts; DNS rebinding does not.                   | Rust `local_page::gate::tests::only_loopback_visitors_asking_for_a_local_name_are_at_this_computer`                                                                                             |
| T5  | A session is listed from its admission until its thread ends.                                                                               | Rust `sessions::live::tests::sessions_are_listed_until_their_entry_drops`                                                                                                                       |
| T6  | The remove commands per system are exact and match the console's.                                                                           | Rust `removal::tests::the_commands_are_the_ones_the_console_shows`                                                                                                                              |
| T7  | `uninstall --purge` tells the server first; the server records the removal and refuses the machine.                                         | Rust `removal::tests::the_report_is_attempted_and_signed_with_the_new_reason`; Vitest `leave.test.ts` "records BMuster removed at the machine…", `local-page-activity.test.ts` "words BMuster…" |
| T8  | The report never blocks the uninstall: an unreachable server, no identity or a slow server all let it go ahead within the limit.            | Rust `removal::tests::an_unreachable_server_or_no_identity_does_not_stop_the_uninstall`, `removal::tests::a_slow_server_is_waited_for_only_up_to_the_limit`                                     |
| T9  | A refused timestamp is retried once (a fresh process signs with this machine's clock).                                                      | Rust `relocate::tests::a_refused_timestamp_is_tried_once_more_with_the_corrected_clock`                                                                                                         |
| T10 | The wire value is `removed-at-machine`.                                                                                                     | Rust `bmuster_protocol::tests::tagged_unions_match_the_spec_shapes`                                                                                                                             |

## Schema and routes

- No migration: audit kinds are text; `machine-removed-at-machine` is added to the list in `src/lib/domain/activity/activity.ts`.
- `POST /agent/v1/leave` accepts the new reason `removed-at-machine` (additive). An older server refuses it as a bad request; the uninstall goes ahead and the machine shows offline there, as before.

## Security notes

- **Details only at this computer.** The organisation, server, computer name and the names of connected people show only to a loopback visitor who asked for a loopback name. The name check matters while the page is open to the network (any `Host` is answered then): without it, a web page that points its own name at 127.0.0.1 could read the details through a browser on this computer.
- **No secrets before sign-in.** The machine id, the page certificate's fingerprint, the data folder, the log and every action stay behind the code. The remove command is the same for every machine and needs administrator rights to run, so showing it to the network gives nothing away.
- **No scripts.** The page's CSP (`default-src 'none'`) stays as it is, so there is no Copy button: the command is in a block that selects whole with one click.
- **The report is authenticated** with the machine's own Ed25519 key, like every agent request, and checked by the same `route.agent` guard (signature, timestamp, not revoked). A non-administrator cannot send it: the CLI checks for administrator rights first, and the key is readable only by root or SYSTEM.
- **Best effort.** The report waits at most 5 seconds; a server that is down, refuses or never answers never keeps BMuster on the machine.

## Open questions

None.

## As built

- **No Copy button.** The CSP allows no scripts, and adding one for this would widen it; the command block selects whole with one click instead (`user-select: all`).
- **Organisation:** the agent does not know the organisation's name, so the page names the server's host name. Sending the name in the check-in reply is a later change.
- **Enrolment time** is not stored by the agent, so the page leaves it out.
- **Notice wording** follows the last desktop ticket since the agent started; before any desktop session it says what the agent does when the server's setting asks for it.
- **Commands:** the console's Linux commands now run `/opt/bmuster/versions/current/bmuster-agent` (the current version, which reports the removal) rather than the rescue copy, and the join page's "To remove it later" shows the `--purge` commands so the server is told. On Windows the program in `Program Files\BMuster` is the rescue copy, refreshed to the current version after a day of health; a rescue copy older than this change uninstalls without telling the server.
- **Windows code not compiled here:** no Windows-only logic changed. The only edit in a Windows-only file is the wording of one log line in `service_windows.rs` ("BMuster Agent").

# SPEC-SESSION-UNITS: Sessions outside the agent's sandbox

**Status:** `IMPLEMENTED` (version bump and changelog left for the release step) · decided by Jack 2026-11-07 · Security work (AGENTS.md: this tool controls other people's computers).

## 1. Problem

The installed Linux agent runs in a hardened systemd unit (`service_linux.rs`): `ProtectSystem=strict`, `ProtectHome=read-only`, `PrivateTmp`, `NoNewPrivileges`, `MemoryDenyWriteExecute`, `RestrictNamespaces`, `RestrictSUIDSGID`, `UMask=0077` and more. Terminal, command (exec, for MCP) and files sessions ran inside that sandbox, so on a real laptop (Linux Mint, systemd 255):

- a new folder in `/home/jack/Downloads` failed with "Read-only file system (os error 30)";
- `sudo` failed;
- `/tmp` was the agent's private one.

## 2. Decision

Keep the agent sandboxed. Start each terminal, exec and files session as its own transient systemd **service**, started by the service manager (PID 1) with `systemd-run`, so only signed, audited sessions get full root. A scope (`systemd-run --scope`) is not enough: its process is forked by the caller and keeps the caller's mount namespace. Removing the agent's sandbox was rejected. Desktop sessions already work and stay in the agent's process.

## 3. Acceptance criteria

| #   | Criterion                                                                                                                                                                                                                                                                          | Test                                                                                                                    |
| :-- | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :---------------------------------------------------------------------------------------------------------------------- |
| U1  | The mode is an explicit setting, never guessed: `run --sessions in-process\|systemd` (Linux), or `BMUSTER_SESSIONS`. Without it, sessions run in the agent's process as before. The agent logs which mode it uses. Unknown values are refused.                                     | `placement::tests`                                                                                                      |
| U2  | The installed unit sets `Environment=BMUSTER_SESSIONS=systemd` and keeps every hardening directive.                                                                                                                                                                                | `service_linux::tests::sessions_run_as_transient_units_outside_the_sandbox`                                             |
| U3  | A terminal runs as `bmuster-terminal-<session id>.service`: a login shell on the agent's own pseudo-terminal, `UMask=0022`, the clean environment and `BMUSTER_USER`. Resizing reaches the shell. Ending the session stops the unit and leaves no processes.                       | `unit::tests::a_terminal_is_a_login_shell_on_its_own_terminal`; end-to-end (section 6)                                  |
| U4  | A command runs as `bmuster-exec-<session id>.service` with `--pipe`: stdout and stderr stay apart, the exit code comes back, the agent's time limit and output cap still apply, and `RuntimeMaxSec` (limit + 10 s) stops it if the agent is gone. `$` reaches the shell unchanged. | `unit::tests::a_command_pipes_its_streams_and_keeps_its_dollars`; `unit::tests::user_manager::*` (needs a user manager) |
| U5  | A files session runs `bmuster-agent files-helper` as `bmuster-files-<session id>.service`. The agent relays the session socket's messages to it unchanged over framed stdin/stdout; every path check runs in the helper.                                                           | `files_helper::tests`                                                                                                   |
| U6  | Session ids that could not name a unit are refused.                                                                                                                                                                                                                                | `unit::tests::only_plain_session_ids_name_units`                                                                        |
| U7  | When the agent starts in a systemd mode it stops session units an earlier run left behind.                                                                                                                                                                                         | end-to-end (section 6)                                                                                                  |

## 4. Design as built

**Mode** (`exec/placement.rs`). `SessionMode` is `in-process`, `systemd`, and in debug builds only `systemd-user` (the caller's user manager, `systemd-run --user`, to try the path without root). Each session gets a `Placement`: `InProcess`, or `Unit(TransientUnit)`. The setting is an environment variable as well as a flag because the launcher in `/opt/bmuster` is only replaced by reinstalling: an older launcher cannot pass a new flag, but the worker inherits the unit's environment through any launcher, so a drop-in turns the mode on without reinstalling.

**Units** (`exec/unit.rs`). Every session unit is started with:

```
systemd-run --quiet --wait --collect --service-type=exec --unit=bmuster-<kind>-<id>.service
  -p KillMode=control-group -p KillSignal=SIGHUP -p TimeoutStopSec=2 -p UMask=0022
  -p WorkingDirectory=<home> [--setenv=NAME=value …] -- <program> <args>
```

- `--wait` makes `systemd-run`'s exit code the service's, so the agent waits for `systemd-run` as for the program itself. `--collect` unloads the unit even when it failed. `--service-type=exec` makes a program that cannot start an error of `systemd-run`.
- Stopping ends the unit's whole control group: SIGHUP (what closing a terminal sends), SIGKILL two seconds later, as the in-process tree kill does.
- No hardening on purpose: an admin's session is full root.
- systemd expands `$NAME` and `${NAME}` in a service's command line, and turns `$$` into `$`, so every `$` in the program's arguments is doubled. (`--expand-environment=no` would do the same but needs systemd 254.)
- Ending a session runs `systemctl stop <unit>` (once; a unit that already ended is not an error), then the in-process tree kill on `systemd-run`'s own session as a backup.

**Terminal** (`exec/pty_unix.rs`). Refined from the first design (`systemd-run --pty`): the agent opens the pseudo-terminal as before and passes its path to systemd with `-p TTYPath=/dev/pts/N -p StandardInput=tty -p StandardOutput=tty -p StandardError=tty`. PID 1 opens it as the shell's controlling terminal. Why not `--pty`:

- `--pty` puts a second terminal and a forwarding process between the agent and the shell. Its resize forwarding did work in a test, but it also treats Ctrl+] pressed three times as "disconnect": the shell lost its terminal and the session reported exit code 0.
- With the agent's own terminal, a resize (`TIOCSWINSZ`) reaches the shell directly, Ctrl+C and job control work as before, and no key sequence ends the session.

The shell is started with `-l` (systemd cannot set `argv[0]` to `-bash`). `systemd-run` itself gets the terminal as stdout and stderr, so a failure to start shows in the console's terminal, and its open copy keeps the terminal from hanging up before the shell opens it.

**Exec** (`exec/pipe.rs`). `systemd-run --pipe` hands its own pipes to the service, so the existing reader threads, time limit and cap work unchanged. At the time limit the agent stops the unit and reports `timedOut` as before.

**Files** (`sessions/files_helper.rs`). The request code moved into `files::Requests`, which both the in-process session and the helper use. `bmuster-agent files-helper` (hidden, Linux) reads frames on stdin and writes frames on stdout: one byte kind (0 text, 1 binary), four bytes big-endian length, the payload (64 MB at most). The agent's relay never parses requests. If the helper stops, the console gets `failed` with the reason. When the session ends the agent closes the helper's input, gives it two seconds, then stops the unit.

**Clean-up.** An agent that dies leaves nothing running: the terminal's master side closes (the shell gets SIGHUP), the helper's input closes, and a command's unit has `RuntimeMaxSec`. On start, a systemd-mode agent also runs `systemctl stop 'bmuster-terminal-*' 'bmuster-exec-*' 'bmuster-files-*'`.

**The agent's sandbox needs no new exception.** As root, `systemd-run` and `systemctl` talk to PID 1 over `/run/systemd/private` (or the system bus socket). Connecting to an existing Unix socket on a read-only mount is allowed (the read-only check applies to files, folders and links, not sockets), `RestrictAddressFamilies` already allows `AF_UNIX`, and the agent writes nothing under `/run`. The terminal's `/dev/pts/N` is the host's because the unit has no `PrivateDevices`. The existing local-page Uninstall already used `systemd-run` from inside the same sandbox.

## 5. Security notes

- Only a ticket the agent has checked (signature, machine, expiry, single use) reaches a session; the mode changes where it runs, not who may run it.
- The unit name comes from the session id, which must be 1–64 ASCII letters, digits or `-`.
- The program and its arguments go after `--`; `$` is escaped; the environment goes through `--setenv`, never the shell.
- Session units are visible to any admin of the machine (`systemctl list-units 'bmuster-*'`) and in the journal.

## 6. Tested

- Unit tests: command lines for all three kinds, `$` escaping, the mode choice, refused session ids, the unit file, the frame format, and a files session relayed to a helper over pipes (folder, upload, download, path check, helper stopping).
- `cargo test -- --ignored` (needs a systemd user manager): a command in its own user unit (split streams, exit code 3, its cgroup, `UMask=0022`, `$X` expanded by the shell) and a command past its time limit (unit and background job gone). Also run from inside a sandboxed user unit.
- End-to-end on systemd 255 (Linux Mint) with a scratch server and a scratch agent running **inside a sandboxed user unit** (`ProtectSystem=strict`, `ProtectHome=read-only`, `NoNewPrivileges`, `RestrictNamespaces`, `MemoryDenyWriteExecute`, `RestrictAddressFamilies`, `UMask=0077`):
  - `in-process`: writing under `$HOME` failed (os error 30), as on the laptop.
  - `systemd-user`: the shell's `/proc/self/cgroup` was `…/bmuster-terminal-<id>.service`; `stty size` went from `24 80` to `43 132` after a resize; Ctrl+C interrupted `sleep`; `umask` was `0022`; `BMUSTER_USER` was set; writing under `$HOME` worked; ending the session left no unit and killed a background `sleep`. A files session made a folder, uploaded 28 kB and downloaded the same bytes under `$HOME`. Stopping the agent stopped the open files unit; killing it with SIGKILL left no session units; a leftover `bmuster-exec-*` unit was stopped when the agent started again.

**Needs real root to verify:** the system manager path from inside the installed unit (`/run/systemd/private` on a read-only `/run`, `ProtectControlGroups`, `NoNewPrivileges`), a root shell in `/system.slice/bmuster-terminal-<id>.service` that can write to `/home`, use `sudo` and see the real `/tmp`, and PID 1 opening the agent's `/dev/pts/N`.

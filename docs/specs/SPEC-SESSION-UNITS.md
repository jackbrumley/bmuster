# SPEC-SESSION-UNITS: Sessions outside the agent's sandbox

**Status:** `IMPLEMENTED` (version bump and changelog left for the release step) · decided by Jack 2026-11-07 · Security work (AGENTS.md: this tool controls other people's computers). The terminal's `TTYPath` and the `--pipe` streams in section 4 were replaced by Version 2 (units connect back, v0.4.4), at the end of this spec.

## 1. Problem

The installed Linux agent runs in a hardened systemd unit (`service_linux.rs`): `ProtectSystem=strict`, `ProtectHome=read-only`, `PrivateTmp`, `NoNewPrivileges`, `MemoryDenyWriteExecute`, `RestrictNamespaces`, `RestrictSUIDSGID`, `UMask=0077` and more. Terminal, command (exec, for MCP) and files sessions ran inside that sandbox, so on a real laptop (Linux Mint, systemd 255):

- a new folder in `/home/jack/Downloads` failed with "Read-only file system (os error 30)";
- `sudo` failed;
- `/tmp` was the agent's private one.

## 2. Decision

Keep the agent sandboxed. Start each terminal, exec and files session as its own transient systemd **service**, started by the service manager (PID 1) with `systemd-run`, so only signed, audited sessions get full root. A scope (`systemd-run --scope`) is not enough: its process is forked by the caller and keeps the caller's mount namespace. Removing the agent's sandbox was rejected. Desktop sessions already work and stay in the agent's process.

## 3. Acceptance criteria

| #   | Criterion                                                                                                                                                                                                                                                                          | Test                                                                                                                                               |
| :-- | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------- |
| U1  | The mode is an explicit setting, never guessed: `run --sessions in-process\|systemd` (Linux), or `BMUSTER_SESSIONS`. Without it, sessions run in the agent's process as before. The agent logs which mode it uses. Unknown values are refused.                                     | `placement::tests`                                                                                                                                 |
| U2  | The installed unit sets `Environment=BMUSTER_SESSIONS=systemd` and keeps every hardening directive.                                                                                                                                                                                | `service_linux::tests::sessions_run_as_transient_units_outside_the_sandbox`                                                                        |
| U3  | A terminal runs as `bmuster-terminal-<session id>.service`: a login shell on the agent's own pseudo-terminal, `UMask=0022`, the clean environment and `BMUSTER_USER`. Resizing reaches the shell. Ending the session stops the unit and leaves no processes.                       | `unit::tests::a_terminal_is_a_login_shell_under_pty_host` (renamed in Version 2); end-to-end (section 6)                                           |
| U4  | A command runs as `bmuster-exec-<session id>.service` with `--pipe`: stdout and stderr stay apart, the exit code comes back, the agent's time limit and output cap still apply, and `RuntimeMaxSec` (limit + 10 s) stops it if the agent is gone. `$` reaches the shell unchanged. | `unit::tests::a_command_runs_under_stdio_host_and_keeps_its_dollars` (renamed in Version 2); `unit::tests::user_manager::*` (needs a user manager) |
| U5  | A files session runs `bmuster-agent files-helper` as `bmuster-files-<session id>.service`. The agent relays the session socket's messages to it unchanged over framed stdin/stdout; every path check runs in the helper.                                                           | `files_helper::tests`                                                                                                                              |
| U6  | Session ids that could not name a unit are refused.                                                                                                                                                                                                                                | `unit::tests::only_plain_session_ids_name_units`                                                                                                   |
| U7  | When the agent starts in a systemd mode it stops session units an earlier run left behind.                                                                                                                                                                                         | end-to-end (section 6)                                                                                                                             |

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

## Version 2: units connect back; nothing of the agent's passes through systemd

**Status:** `IMPLEMENTED (v0.4.4)` · approved 2026-11-09 (Jack: "go" on "helpers connect back over a root-only socket, no file descriptors passed through systemd") · security work. CB7 (native test on Fedora and Mint) is pending; see As built.

### Evidence (Fedora 44, SELinux enforcing, agent 0.4.2)

- Terminal exit 208: `avc: denied { open } for pid=1 comm="systemd" path="/dev/pts/3" scontext=system_u:system_r:init_t:s0 tcontext=system_u:object_r:devpts_t:s0`. systemd (init_t) may not open the pty the agent (unconfined_service_t) made, so `TTYPath=` + `StandardInput=tty` fails before bash starts.
- Console and Wayland helpers: `systemd-run --pipe` fails with "Failed to start transient service unit: Connection reset by peer": systemd refuses the agent's pipe file descriptors sent over D-Bus.
- The policy is correct for systemd; BMuster must not need an exception. No SELinux policy, boolean or label changes.

### Design

1. Every transient unit (terminal, command, files, console capture helper, Wayland helper) is started with plain stdio (`StandardInput=null`, output to the journal) and runs a BMuster program, never the target directly.
2. Before starting the unit, the agent creates a listening Unix socket for that one session: `/run/bmuster/connect/<random 128-bit name>.sock`. The folder is `0711 root`; the socket is `0600` owned by the uid the unit runs as (root for terminal-as-root, files and console; the user for the Wayland helper and for terminals that run as a user). The socket path is the only argument passed; it is not a secret.
3. The unit's program connects to the socket. The agent accepts **one** connection and checks the peer with `SO_PEERCRED`: its uid must be the unit's, and `/proc/<pid>/cgroup` must name exactly the unit the agent started. Anything else is closed and logged. The listening socket is removed as soon as the connection is accepted, and after 10 seconds if nobody connects (the session then fails with "The session's helper did not connect" and the startup diagnostics run).
4. **Terminal:** the unit runs `bmuster-agent pty-host <socket> -- <shell> -l`. `pty-host` creates the pty itself, inside the unit, starts the shell as its controlling terminal, and relays bytes, resize and exit status over the socket using the existing terminal framing. systemd never sees the pty.
5. **Command and files:** the unit runs `bmuster-agent stdio-host <socket> -- <program>`, which relays stdin, stdout, stderr and the exit status as framed channels.
6. **Console capture and Wayland helpers:** the helpers speak their existing pipe protocol over the socket instead of stdin/stdout.
7. Ending a session closes the socket and stops the unit (`systemctl stop`), as now. A helper whose socket closes exits at once.

### Checks and diagnostics

The SPEC-DIAGNOSTICS checks `systemd-run-pipe` and `terminal-pty` are replaced by `unit-connect-back` (a unit that connects back, passes the peer check and echoes a line) and `pty-host` (a terminal unit that runs `/bin/true` under `pty-host`). The old paths are deleted, not kept as fallbacks.

### Acceptance criteria

| #   | Criterion                                                                                                           | Named test                                                       |
| :-- | :------------------------------------------------------------------------------------------------------------------ | :--------------------------------------------------------------- |
| CB1 | The connect socket is per session, `0600` for the unit's uid in a `0711` folder, removed on accept or after 10 s.   | Rust `connect::tests::socket_lifecycle`                          |
| CB2 | Only a peer with the unit's uid in exactly the started unit's cgroup is accepted; others are refused and logged.    | Rust `connect::tests::peer_must_be_the_unit`                     |
| CB3 | No unit property passes a pty path or an agent file descriptor (`TTYPath`, `StandardInput=tty`, `--pipe` are gone). | Rust `exec::unit::tests::units_take_no_agent_descriptors`        |
| CB4 | `pty-host` gives the shell a controlling terminal, relays resize and exit status, and exits when the socket closes. | Rust `pty_host::tests::shell_round_trip` (runs without root)     |
| CB5 | Command and files sessions relay stdin, stdout, stderr and exit status through `stdio-host`.                        | Rust `stdio_host::tests::channels_round_trip`                    |
| CB6 | Console and Wayland helpers work over the socket; a closed socket ends them.                                        | Rust `console_helper::tests::over_socket`, `wayland` helper test |
| CB7 | Native: terminal, files and desktop on the Fedora SELinux laptop and on Mint; no new AVC denials.                   | Manual, read through `npm run diagnostics`                       |

### As built (v0.4.4)

| #   | Status  | Test                                                                                                                                                             |
| :-- | :------ | :--------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CB1 | passing | `exec::connect::tests::socket_lifecycle` (also: a symlinked folder is refused, a `0755` folder is put back to `0711`, leftovers are swept at start)              |
| CB2 | passing | `exec::connect::tests::peer_must_be_the_unit`, `user_units_live_under_the_users_manager`                                                                         |
| CB3 | passing | `exec::unit::tests::units_take_no_agent_descriptors` (session units, the console helper's and the Wayland helper's arguments)                                    |
| CB4 | passing | `exec::pty_host::tests::shell_round_trip`, `a_closed_socket_ends_the_shell_and_its_jobs`, `a_program_that_cannot_start_says_why` (run as the developer, no root) |
| CB5 | passing | `exec::stdio_host::tests::channels_round_trip` (3 MB of input through `cat`), `a_closed_socket_ends_the_program`, `a_program_that_cannot_start_says_why`         |
| CB6 | passing | `console_helper::tests::over_socket`, `wayland::helper::tests::over_socket`                                                                                      |
| CB7 | pending | Not run yet: needs the Fedora 44 laptop (SELinux enforcing) and the Mint machine with a root agent.                                                              |

- **Modules** (`agent/crates/agent/src/exec/`): `connect.rs` (folder, socket, peer check, starting a unit and waiting for it), `channel.rs` (frames), `host.rs` (the agent's side: the frames become a stdout reader, a stderr reader, an input writer and the exit code, so `pipe.rs`, `pty_unix.rs` and `files_helper.rs` keep their shapes), `pty_host.rs`, `stdio_host.rs`. `unit::Io` (terminal, pipe, detached) is gone: every unit gets `-p StandardInput=null -p StandardOutput=journal -p StandardError=journal`, and `RuntimeMaxSec` is a plain option.
- **Frames.** One byte for the channel, four bytes big-endian length, the payload (at most 1 MB; longer runs are split): agent to host `input`, `input-closed`, `resize` (cols, rows); host to agent `stdout`, `stderr`, `exit` (i32), `failed` (the program could not start, with the reason, which the console shows). Not the session socket's text/binary messages: the hosts carry raw channels. A connection that closes without `exit` fails the session with "The session's host ended without an exit code".
- **pty-host** waits for a `resize` first, then runs the shell with the same `Pty::spawn` the agent's own terminals use (setsid, `TIOCSCTTY`). `-l` stays (systemd cannot set `argv[0]`). After the shell exits it ends the shell's session (background jobs), as the agent's own terminals do. Input waits in a 64-chunk queue so a shell that is not reading never stops the host noticing the socket close.
- **stdio-host** runs the program as the leader of its own session with three pipes; after it exits the host reads for up to 1 s more, ends the session's leftovers and sends `exit`. A command gets `input-closed` at once (no input, as before). The files helper runs under it: `stdio-host <socket> -- <agent> files-helper`, and its stderr still ships as `files-helper`.
- **Helpers.** `console-helper <socket>` and `wayland-helper <socket>` speak the existing wire format over the socket. Their units keep every property they had except `--pipe`. The console helper's socket belongs to root; the Wayland helper's to the user it runs as. Connecting works inside the console helper's `ProtectSystem=strict` and `PrivateNetwork=yes` (a path socket on a read-only mount is still connectable, and is not a network). Ending the client shuts the socket down, so the helper ends even before `systemctl stop`.
- **Logs.** Only `systemd-run`'s own lines are shipped live now (under the helper's name, and quoted in the error when the unit never connects). The console and Wayland helpers' own messages, and `gst-launch`'s, go to the journal with their unit, which the fixed journal query already covers and ships after a failure.
- **Socket folder.** `/run/bmuster/connect` is made by the agent inside its `RuntimeDirectory=bmuster` (writable under `ProtectSystem=strict`); the agent's unit file is unchanged. The development `systemd-user` mode uses `$XDG_RUNTIME_DIR/bmuster-connect`, and its peer check expects `/user.slice/user-<uid>.slice/user@<uid>.service/[<x>.slice/]<unit>`. The system check expects exactly `/system.slice/<unit>` on every systemd line of `/proc/<pid>/cgroup` (the unified `0::` line, or v1's `name=systemd`).
- **Order of the socket's set-up.** The socket is bound, then set to `0600` and given to the unit's uid; until then it has the agent's `UMask=0077` (root only), and its name is 128 random bits in a folder nobody else can list.
- **Pid in the peer check.** `SO_PEERCRED` gives the pid at `connect()`. A process that connected and exited could in theory have its pid reused by a process of the unit; it would still need the unit's uid and access to the `0600` socket, which only root and that uid have.
- **Renamed tests.** U3's test is now `unit::tests::a_terminal_is_a_login_shell_under_pty_host`, U4's `unit::tests::a_command_runs_under_stdio_host_and_keeps_its_dollars`. The `user_manager` tests (`cargo build && cargo test -- --ignored`) start the built agent as the host; they passed on the developer's machine (systemd user manager, real cgroup peer check), as did the new `user_manager::a_terminal_unit_has_its_own_pty_and_resizes` and `checks::linux::tests::the_unit_checks_pass_under_the_user_manager` (`systemd-run`, `unit-connect-back` and `pty-host` against the user manager).
- **Checks.** `systemd-run-pipe` and `terminal-pty` are gone. `unit-connect-back` runs `/bin/cat` under `stdio-host` in `bmuster-exec-check-<hex>.service`; `pty-host` runs `/bin/true` under `pty-host` in `bmuster-terminal-check-<hex>.service`. Both follow the session mode (`not-applicable` in-process), so a development agent in `systemd-user` mode runs them too.
- **Not natively tested (CB7):** the system manager path as root inside the installed unit, SELinux on Fedora (whether `init_t` may execute the agent's binary as the unit's program and whether the unit may connect to the agent's socket in `/run/bmuster/connect`), the console helper's connect from inside its sandbox, and the Wayland helper as the signed-in user. Run `npm run diagnostics` against the laptop after installing 0.4.4: `unit-connect-back`, `pty-host` and `kms-capture` should pass and the `audit` check should show no new denials.

## Version 3: everything systemd starts lives under /opt

**Status:** `IMPLEMENTED (v0.4.5)` · approved 2026-11-09 (follows from the 0.4.4 native test; Jack: "get what you can done overnight") · security work. O6 (native test on Fedora and Mint) is pending; see As built.

### Evidence (Fedora 44, agent 0.4.4)

The pty and pipe denials are gone. The units now fail with `203/EXEC`: `avc: denied { execute } for comm="(bmuster-agent)" scontext=system_u:system_r:init_t:s0 tcontext=system_u:object_r:var_lib_t:s0`. systemd may not execute a program stored under `/var/lib` (`var_lib_t`). The same applies to the agent's 24-hour rescue refresh (it runs the `/var/lib` copy through `systemd-run`) and to a unit file that names `/var/lib/bmuster/versions/current/bmuster-agent` as `ExecStart`. Fedora's SELinux troubleshooter shows a desktop alert for each denial, so every failed attempt is visible to the person at the machine.

### Design

1. Program files live under `/opt/bmuster`, data under `/var/lib/bmuster`:
   - `/opt/bmuster/versions/<version>/bmuster-agent`, with `current` and `previous` links (moved from `/var/lib/bmuster/versions`);
   - `/opt/bmuster/bmuster-agent` stays the rescue copy.
2. New version files are **written** (copied) into `/opt/bmuster/versions`, never renamed in from elsewhere, so they take the folder's normal label (`usr_t` on Fedora). No SELinux policy, label or boolean is changed, and `chcon`/`semanage` are never run.
3. The agent's unit adds `/opt/bmuster` to `ReadWritePaths` (and nothing else), so the updater can write new versions there. `ExecStart` is `/opt/bmuster/versions/current/bmuster-agent launch`.
4. Every transient unit (terminal, command, files, console helper, Wayland helper, checks, refresh) runs `/opt/bmuster/versions/current/bmuster-agent`. The Wayland helper copy under `/run/bmuster` is removed.
5. **Moving an installed agent** (0.4.1–0.4.4 layout, still under the old sandbox, which cannot write `/opt` or `/etc`): the new worker, on start, runs fixed system programs as short transient units, each a plain `bin_t` program that systemd may execute:
   1. `/usr/bin/install -D -m 0755 <its own /var/lib path> /opt/bmuster/versions/<version>/bmuster-agent` (and the same for `previous`, if present);
   2. `/usr/bin/ln -sfn` for `current` and `previous`;
   3. `/usr/bin/install -m 0644 <unit text written to /var/lib/bmuster/staged-units/> /etc/systemd/system/bmuster-agent.service` (and the rescue unit), then `systemctl daemon-reload`.
      It then logs "Moved the program files to /opt/bmuster; they apply from the next start" and, when idle (no session), restarts itself with `systemctl restart --no-block bmuster-agent`. Each step is idempotent; a failure is logged with its exit status and retried at the next start. The old `/var/lib/bmuster/versions` folder is deleted after a healthy start from `/opt`.
6. The rescue refresh, rescue and updater code use the `/opt` paths only (one layout, no fallback).
7. Self-checks never repeat a check that failed with a permission denial more than once per agent version, so a machine at a policy wall does not raise a desktop alert every six hours. The result stays visible in diagnostics.

### Acceptance criteria

| #   | Criterion                                                                                                           | Named test                                                               |
| :-- | :------------------------------------------------------------------------------------------------------------------ | :----------------------------------------------------------------------- |
| O1  | New versions are copied (not renamed) into `/opt/bmuster/versions/<v>` with `current`/`previous` links.             | Rust `updates::tests::versions_are_written_under_opt`                    |
| O2  | Every unit's `ExecStart` and every transient unit's program is under `/opt/bmuster/versions/current`.               | Rust `exec::unit::tests::programs_live_under_opt`, `service_linux` tests |
| O3  | The agent unit's only writable paths are `/var/lib/bmuster` and `/opt/bmuster`; the sandbox is otherwise unchanged. | Rust `service_linux::tests::sandbox_writes_only_data_and_program`        |
| O4  | Moving an old install runs only the fixed system programs, is idempotent, and survives each step failing.           | Rust `relocate::tests::move_from_var_lib_steps` (fake runner)            |
| O5  | A check that failed with a permission denial is not repeated within the same version.                               | Rust `checks::tests::denied_checks_run_once_per_version`                 |
| O6  | Native: Fedora (SELinux enforcing) and Mint: terminal, files, desktop and all checks pass, with no new AVC denials. | Manual, through `npm run diagnostics`                                    |

### As built (pending release)

| #   | Status  | Test                                                                                                                                                                                                 |
| :-- | :------ | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| O1  | passing | `updates::tests::versions_are_written_under_opt` (also: the next switch prunes the oldest folder, a rollback removes the failed one, a version can never name another path)                          |
| O2  | passing | `exec::unit::tests::programs_live_under_opt`, `service_linux::tests::unit_runs_the_current_version_and_spares_revoked_exits` (unit, rescue unit, refresh and uninstall units)                        |
| O3  | passing | `service_linux::tests::sandbox_writes_only_data_and_program` (the whole hardening block, line by line)                                                                                               |
| O4  | passing | `move_to_opt::tests::move_from_var_lib_steps` (fake runner; every one of the eight steps failing once, then the next start running only the rest; the rescue refresh, once, and its failure retried) |
| O5  | passing | `checks::tests::denied_checks_run_once_per_version`                                                                                                                                                  |
| O6  | pending | Not run yet: needs the Fedora 44 laptop (SELinux enforcing) and the Mint machine, updating from 0.4.4.                                                                                               |

- **Layout** (`updates::Layout`, `paths::versions_dir`). The installed Linux agent's versions are `/opt/bmuster/versions/<version>/` with `current` and `previous` symlinks (relative, so `current` names `<version>`), switched by renaming a new link over the old one. A download is written into `versions/incoming/` and renamed to `versions/<version>/` within that folder, so it keeps the label it was written with; nothing is renamed into `/opt` from elsewhere. Folders no link names are pruned, so two versions stay. Binaries and folders are `0755` (user helpers run the binary). A development run with its own `--data-dir` keeps the same shape in `<data>/versions`. Windows keeps its folder slots (`current`, `previous`, `incoming` renamed), unchanged.
- **Update state moved out of the versions.** `switch.json`, `checked-in` and `rescue-copy.json` are in `/var/lib/bmuster` now (they are data); on Windows they stay in `versions\`, because the launcher there is the Program Files copy, which may be older than the worker and looks for them there.
- **Recovery.** At start the launcher finishes a switch whose record is written but whose links are not (`promote` of the build in `incoming` or already in `<version>/`); if that build is gone (a rollback cut short), it ends the switch and stays on the running version. Before this, a crash between the switch record and the first rename made the trial run the old version and roll back two versions.
- **Programs.** `exec::unit::program(Manager::System)` is `/opt/bmuster/versions/current/bmuster-agent` for terminal, command and files units and the checks' units; `wayland::helper_program()` is the same path for the console and Wayland helpers, after checking that the file and every folder above it are root's and writable by nobody else. The `/run/bmuster/bmuster-user-helper` copy and `publish_helper` are deleted. The rescue refresh and the local page's uninstall run the `/opt` binary through `systemd-run`, and refuse (with the reason) while it is missing. The development user manager still runs this build.
- **Moving an install** (`move_to_opt.rs`; the spec named `relocate.rs`, which already holds moving to another server, so O4's test is `move_to_opt::tests::move_from_var_lib_steps`). A worker started by an installed launcher from `/var/lib/bmuster/versions` runs, on a thread, as `systemd-run --wait --collect --service-type=exec` units: `/usr/bin/install -D -m 0755` of `current/bmuster-agent` and `-m 0644` of its `release.json` into `/opt/bmuster/versions/<version>/` (and the same for `previous`), `/usr/bin/ln -sfn <version>` for each link, `/usr/bin/install -m 0644` of each changed unit file staged in `/var/lib/bmuster/staged-units/`, then `/usr/bin/systemctl daemon-reload`. Each step runs only when its result is missing (files compared byte for byte, links read); the staged folder is removed only after the reload, so a failed reload is retried. A failure is logged with the step and its exit status, and the next start tries again. Then it logs "Moved the program files to /opt/bmuster; they apply from the next start", and every 30 s looks for a moment with no session and no older launcher's switch still on trial, then, once this version has checked in (`/var/lib/bmuster/checked-in` names it), runs `/usr/bin/install -m 0755 /opt/bmuster/versions/<version>/bmuster-agent /opt/bmuster/bmuster-agent` as a unit, so the rescue copy is this version (the 0.4.4 copy only knows `/var/lib/bmuster/versions`, which is deleted) and records it in `/var/lib/bmuster/rescue-copy.json`; it is skipped when the bytes already match, and a failure is logged once and retried every 30 s, holding the restart back. Then it runs `/usr/bin/systemctl restart --no-block bmuster-agent.service` as a unit. The rescue code in this version (`rescue`, `refresh-rescue`) knows only the `/opt` layout. (Added at review: the spec's step 5 did not list the rescue refresh.) While it waits, offered updates are left for later (`/opt` is read-only in the old sandbox).
- **The older launcher.** 0.4.1–0.4.4 launchers watch `/var/lib/bmuster/versions/checked-in`, so a worker running from there also writes that marker (otherwise the old launcher would roll the update back). A new launcher that an old unit still starts from `/var/lib` (a restart before the unit files were rewritten) does not touch `/opt`: it ends an old switch to its own version (recorded as updated), runs its own binary as the worker and leaves updates for later.
- **Clean-up.** After the first check-in of a worker running from `/opt`, `/var/lib/bmuster/versions` is deleted. The rescue copy's record is carried over to `/var/lib/bmuster/rescue-copy.json` before the move. `uninstall` removes both the old and the new folders and the state files.
- **Denied checks** (`checks/denied.rs`). A failed check counts as denied when its detail says so (`Permission denied`, `Operation not permitted`, `Access denied`, `avc: denied`, `203/EXEC`), or when the same run's `audit` check found denials in its 15-minute window. Its result is kept in `/var/lib/bmuster/checks-denied.json` with the version; until the version changes the check is not run (also not for an admin's Run checks) and the kept result, starting "Not run again until the next agent version: it failed with a permission denial.", stands in, with its original time. Checks that fail otherwise run every time.
- **Fresh installs** seed `/opt/bmuster/versions/<version>` and its `current` link directly; `docs/install.sh` needed no change.
- **Open points for the native test (O6):**
  - whether `init_t` may execute `/opt/bmuster/versions/<version>/bmuster-agent` (`usr_t`) for the agent unit and every transient unit, and whether the move's `install`, `ln` and `systemctl` units run as the spec expects;
  - Tests were written alongside the code rather than strictly before it.

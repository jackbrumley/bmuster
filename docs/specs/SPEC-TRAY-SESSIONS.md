# SPEC-TRAY-SESSIONS: The tray in every signed-in desktop

**Status:** `IMPLEMENTED (v0.4.8)` (Linux) · Windows `IMPLEMENTED (v0.4.19)` · Approved by Jack, 2026-11-10; Windows asked for 2026-11-11 after testing 0.4.17 on a Windows 10 PC. Extends SPEC-AGENT-TRAY.

**This is security work.** A root service now starts a program inside another person's desktop session. The rules below keep that to one fixed program with fixed arguments, run as that person, never as root, and never more than once per person.

## Problem

On a Fedora 44 GNOME laptop the BMuster tray icon never shows, although other StatusNotifierItem apps running as the same person (Voquill, SomeDrive) show theirs, so GNOME's AppIndicator host works. The agent runs as a root systemd service; the icon comes from the per-user helper `bmuster-agent tray`, which only `/etc/xdg/autostart/bmuster-agent.desktop` starts, at sign-in.

1. Nothing starts the helper in sessions that were already signed in when the agent was installed or updated.
2. The autostart entry is written only by the installer, with `Exec=/opt/bmuster/bmuster-agent tray` (the rescue copy). Since SPEC-SESSION-UNITS Version 3 the running version lives at `/opt/bmuster/versions/current/bmuster-agent`; an install from 0.3.2 keeps whatever the installer wrote then.
3. Diagnostics cannot see the tray: the helper logs only on the machine.

## Behaviour

1. **Start the helper in each signed-in desktop (Linux).** A `tray sessions` thread in the worker reads logind's session records in `/run/systemd/sessions/` every 10 s (the files `sd-login` itself reads). A session gets a helper when `CLASS=user`, `TYPE` is `wayland` or `x11`, `STATE` is `active` or `online`, the uid is at least 1000 and not 65534, and the user is not a greeter account (`gdm`, `sddm`, `lightdm`, `gnome-initial-setup`). Users are counted once, however many sessions they have.
2. **How it starts.** As the person, in their own systemd user manager, so it gets their session's environment (`DBUS_SESSION_BUS_ADDRESS`, `WAYLAND_DISPLAY` or `DISPLAY`, `XDG_RUNTIME_DIR`) and their slice:

   ```
   systemd-run --machine=<user>@.host --user --quiet --collect --service-type=exec
     --unit=bmuster-tray.service --description=BMuster tray
     --property=PartOf=graphical-session.target --property=NoNewPrivileges=yes
     -- /opt/bmuster/versions/current/bmuster-agent tray
   ```

   systemd runs the program from `/opt` (SELinux lets it; never `/var/lib`). The user name comes from logind and must be a plain account name (letters, digits, `_`, `-`, `.`, not starting with `-`); anything else is skipped.

3. **Once per person.** Before starting, the agent looks in `/proc` for a process of that uid whose command line is exactly `<…>/bmuster-agent tray`; if there is one (started by autostart or by the agent), nothing happens. The unit name is fixed per user, so systemd refuses a second. The helper itself takes a single-instance lock (`flock` on `$XDG_RUNTIME_DIR/bmuster-tray.lock`, opened without following links, mode 0600); a second helper exits quietly with success.
4. **Timing.** A session must have been seen for 30 s before its first start, so the desktop has imported its environment into the user manager (this also covers sessions present at agent start and after an update, since an update restarts the worker). A person gets at most one start attempt a minute, whatever happens to the helper. A failure is logged as a warning when its reason changes, otherwise at debug.
5. **Keep the shortcuts current.** On every start of an installed agent the worker compares the autostart entry and the applications-menu entry with what this version writes (both point at `/opt/bmuster/versions/current/bmuster-agent`). A file that differs is staged in `/var/lib/bmuster/staged-shortcuts/` and put in place by `/usr/bin/install -D -m 0644` run as a short `systemd-run --wait` unit, because the service's sandbox cannot write `/etc` or `/usr` (the same way SPEC-SESSION-UNITS moves the unit files). Identical files are left alone.
6. **Self-check `tray`** (SPEC-DIAGNOSTICS). Not applicable when nobody is signed in at a graphical session. Otherwise it fails, with each reason in plain words, when the autostart entry is missing or starts another program, when a signed-in person has no helper running, or when their session bus has no `org.kde.StatusNotifierWatcher` (no tray host: on GNOME, the AppIndicator extension). It passes naming each person, their helper's process id and the watcher. The server shows checks generically, so no server change is needed.
7. **Windows** has its own starter: see "Windows" below.

## Acceptance criteria

| ID  | Behaviour                                                                                                                                      | Named test                                                             |
| :-- | :--------------------------------------------------------------------------------------------------------------------------------------------- | :--------------------------------------------------------------------- |
| TS1 | Only user-class Wayland or X11 sessions, active or online, of real users (not greeters, root, nobody or odd names) get a helper, once per uid. | Rust `tray::starter::tests::which_sessions_get_a_helper`               |
| TS2 | The start command is the fixed `systemd-run` user-manager call with the fixed program and the one argument `tray`.                             | Rust `tray::starter::tests::the_start_command_is_fixed`                |
| TS3 | A person whose helper already runs gets no start; a new one waits 30 s; a person who signed out is forgotten.                                  | Rust `tray::starts::tests::once_per_user`                              |
| TS4 | A failed or exited helper is started again at most once a minute.                                                                              | Rust `tray::starts::tests::at_most_once_a_minute`                      |
| TS5 | `/proc` finds the helper by uid and exact command line, not `tray --open` or another program.                                                  | Rust `tray::starter::tests::finds_the_helper_in_proc`                  |
| TS6 | The shortcuts point at the current program and are rewritten, through `/usr/bin/install`, only when they differ.                               | Rust `tray::linux::tests::shortcuts_are_rewritten_only_when_different` |
| TS7 | A second helper for the same person does not get the lock; the lock frees when the first ends.                                                 | Rust `tray::linux::tests::one_helper_per_person`                       |
| TS8 | The `tray` check is not applicable with nobody signed in, fails naming each missing piece, and passes when all are there.                      | Rust `checks::tray::tests::tray_check_outcomes`                        |
| TS9 | `tray` is in the Linux check list, after `portal`.                                                                                             | Rust `checks::tests::linux_checks_report_each_status`                  |

## Security notes

- The only program ever started in a person's session is `/opt/bmuster/versions/current/bmuster-agent` with the single argument `tray`. Nothing from the server, the browser or the session changes the program, its arguments or its environment.
- It runs as the person, in their user manager, with `NoNewPrivileges=yes`; `tray` still refuses to run as root. The helper reads only the public status document (SPEC-AGENT-TRAY) and holds no agent capability, so a person who replaces or kills it gains nothing.
- The user name is the one logind recorded, checked against a plain account-name pattern before it reaches `--machine=`; it is passed as one argument, never through a shell.
- The `/proc` lookup only reads command lines and uids. The check's bus query runs `busctl` as the person (as the `portal` check does).
- The shortcut rewrite runs only `/usr/bin/install` with fixed target paths, from files the agent staged in its own private data folder. No sandbox setting of the agent's unit changes.

## Open questions

1. ~~**Windows has the same gap.**~~ Closed: see "Windows" below.
2. **Desktops without a systemd user session** (some X11 window managers) do not import `DISPLAY` into the user manager. The icon still shows (it needs only the session bus), but Open and Copy may fail until the next sign-in starts the autostart copy. Acceptable for now?

## As built

- `agent/crates/agent/src/tray/starter.rs`: session parsing and filtering, the `/proc` lookup, the rate-limited `Starter`, the `systemd-run` arguments and the worker thread (`tray::starter::start`), which runs only as root on an installed, launched agent whose current program exists.
- `agent/crates/agent/src/tray/linux.rs`: shortcuts built from `paths::CURRENT_PROGRAM`, `refresh_shortcuts` through the `move_to_opt` step runner (now shared, with a unit-name prefix per use), and the helper's single-instance lock taken by `tray::run`.
- `agent/crates/agent/src/checks/tray.rs`: the `tray` check and its pure verdict; the bus query reuses the `portal` check's `busctl` call.
- Deviation: the task suggested `systemctl --machine=<user>@.host --user is-active bmuster-tray` before starting. The `/proc` lookup replaces it, because it also sees a helper started by the autostart entry, which runs outside that unit.
- Not run natively yet: the start on Fedora 44 GNOME and the shortcut rewrite under SELinux. Record them in the release test before calling them verified.

### Fix in 0.4.13

On the Fedora laptop, 0.4.12 logged "Could not start the tray for jackbrumley (uid 1000): /usr/bin/systemd-run exited with exit status: 1: Failed to start transient service unit: Connection reset by peer". `systemd-run --machine=<user>@.host --user` reaches the user manager through a piped stdio bridge, and SELinux resets that pipe for the agent's domain, as it did `--pipe` in 0.4.1. The agent now runs `systemd-run --user` itself **as the person** (their uid, the gid of `/run/user/<uid>`, which must belong to them; a clean environment with only `XDG_RUNTIME_DIR` and `DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/<uid>/bus`), the same way the checks already ask that bus with `busctl`. The arguments are otherwise unchanged; the account-name check still decides who gets a helper.

**Helpers follow updates (added for 0.4.17).** A tray helper that is running when the agent moves to a new version notices within 5 s that `/opt/bmuster/versions/current/bmuster-agent` now points at another program, and exits. The agent's tray starter runs the new one within about 30 s, so new tray features (such as the connected notice, SPEC-DESKTOP section 18) show without signing out and in. A link that cannot be read mid-switch is not a new version. Test: `tray::linux::tests::the_helper_sees_when_the_current_version_moves`.

## Windows (IMPLEMENTED (v0.4.19))

**Problem.** On a Windows 10 PC with 0.4.17 the tray icon does not appear for a person who was already signed in when the agent was installed or updated. The helper starts only from the `HKLM\Software\Microsoft\Windows\CurrentVersion\Run` entry, at sign-in.

**This is security work.** A LocalSystem service now starts a program inside other people's sessions. The rules below keep that to one fixed program with one fixed argument, run with the person's own unelevated token, never as SYSTEM, and at most once per session.

### Behaviour

1. **Which sessions.** The worker's `tray sessions` thread lists the sessions every 10 s (`WTSEnumerateSessionsW`). A session gets a helper when its state is active or connected (`WTSActive`, `WTSConnected`: someone at the screen or over Remote Desktop), someone is signed in to it (`WTSUserName` is not empty), and it is not session 0 (services, no screen). A disconnected session waits until its person comes back. Each session counts once.
2. **When.** The same rules as Linux, through one shared `Starter`: a session is seen for 30 s before its first start (the `Run` entry gets the first go at sign-in), a session whose helper runs gets nothing, and a session gets at most one attempt a minute. A failure is logged as a warning when its reason changes, otherwise at debug. A start is logged as "Started the tray in session 2 (jack)."
3. **Is a helper running?** A process in that session whose program is the installed program (`QueryFullProcessImageNameW`, the full path compared in any case). The desktop helper runs from `ProgramData\BMuster\versions\current` as SYSTEM, so it never counts.
4. **How it starts.** `WTSQueryUserToken(session)`. When that token is the elevated half of an administrator's pair (`TokenElevationTypeFull`), its linked, filtered token is used instead, duplicated as a primary token. The token must then not be the elevated half of a pair (`TokenElevationTypeLimited`, or `TokenElevationTypeDefault`: a standard account, or an account with UAC switched off, whose one token everything in the session already runs with), belong to a person (`S-1-5-21-…`: a local, Microsoft or domain account; `S-1-12-1-…`: a Microsoft Entra account; never SYSTEM, LOCAL SERVICE, NETWORK SERVICE or a built-in group) and name that session. Otherwise nothing starts and the reason is logged. The helper starts with `CreateProcessAsUserW`: that token, the person's own environment (`CreateEnvironmentBlock`), the `winsta0\default` desktop, no inherited handles, no console window, the program folder as its working folder, and the command line `"C:\Program Files\BMuster\bmuster-agent.exe" tray`.
5. **Which program.** `C:\Program Files\BMuster\bmuster-agent.exe`, the copy the `Run` entry starts. The running version in `C:\ProgramData\BMuster\versions\current` is readable by SYSTEM and Administrators only (the data folder holds the key), so a person's token cannot run it. The Program Files copy is the rescue copy: every install replaces it, and the running version copies itself over it after a day of health (SPEC-SERVER-UPDATES).
6. **Once per session.** The helper creates the mutex `Local\BMusterTray` (the `Local\` namespace is per session) before anything else. When it already exists, the helper exits quietly with success.
7. **Helpers follow updates.** The helper notes which file its program is (NTFS volume serial and file index) when it starts, and looks again every 5 s. When another file stands at that path (an install or the rescue-copy refresh moved the running one aside and put the new version there), the helper removes its icon and exits. The starter runs the new program within about 30 s. A path that cannot be read mid-switch is not a new version.
8. **Uninstall.** After the service is stopped and deleted, uninstall ends every helper still running the installed program, in every session, so the program folder can be removed. It enables the debug privilege first, so an administrator's uninstall can end a helper that runs as someone else. Without this, a reinstall could not delete the folder while someone's tray ran from it.
9. Only the installed agent starts helpers: a worker started by the launcher (`run --launched`) with the default data folder, whose Program Files program exists.

### Acceptance criteria

| ID   | Behaviour                                                                                                                                 | Named test                                                                                 |
| :--- | :---------------------------------------------------------------------------------------------------------------------------------------- | :----------------------------------------------------------------------------------------- |
| TS3  | (Now shared with Windows.) A session whose helper runs gets no start; a new one waits 30 s; one that ended is forgotten.                  | Rust `tray::starts::tests::once_per_user`                                                  |
| TS4  | (Now shared with Windows.) A failed or exited helper is started again at most once a minute.                                              | Rust `tray::starts::tests::at_most_once_a_minute`                                          |
| TS10 | Only active or connected sessions with someone signed in get a helper; never session 0 or a disconnected session; each once, in id order. | Rust `tray::windows_sessions::tests::which_windows_sessions_get_a_helper`                  |
| TS11 | An elevated token is swapped for its linked token; unknown elevation types and anything but a person's account are refused.               | Rust `tray::windows_sessions::tests::the_helper_never_runs_elevated_or_as_a_service`       |
| TS12 | The command line is the quoted installed program and `tray`; the mutex is `Local\BMusterTray`.                                            | Rust `tray::windows_sessions::tests::the_windows_helper_command_is_fixed`                  |
| TS13 | The helper exits when another file stands at its program's path, not when the path cannot be read.                                        | Rust `tray::windows_sessions::tests::the_windows_helper_sees_when_its_program_is_replaced` |

### Security notes

- The tray runs as the signed-in person with their own token, never as SYSTEM in their session (unlike the desktop helper, which needs SYSTEM to reach the sign-in and UAC desktops). An administrator's elevated token is never used: its filtered half is, and the starter checks again that the result is not elevated. With UAC switched off a person has one token, and the tray gets the same rights as everything else they run.
- Only active or connected sessions with a person signed in get a helper; session 0 never does. The token must belong to a person's account and to that session.
- The program and its one argument are fixed: the Program Files copy, which only Administrators and SYSTEM can write, and `tray`. Nothing from the server, the browser or the session changes them. The person's environment comes from their own profile; the service's is not passed on.
- The helper holds no agent capability: it reads only the public, ACL-checked status documents (SPEC-AGENT-TRAY). A person who ends or replaces it gains nothing. Someone who creates `Local\BMusterTray` in a session first only keeps the icon from showing there.
- The debug privilege is enabled only in the short-lived uninstall process, which an administrator or SYSTEM already runs, and only to end BMuster's own tray helpers, matched by their full program path.

### As built

- `agent/crates/agent/src/tray/starts.rs`: the shared `Starter`, moved from `starter.rs` and made generic over who gets a helper, with TS3 and TS4.
- `agent/crates/agent/src/tray/windows_sessions.rs`: the pure decisions (TS10 to TS13).
- `agent/crates/agent/src/tray/windows_starter.rs`: the session list, the helper lookup, the token, `CreateProcessAsUserW`, the worker thread (`tray::windows_starter::start`, from `worker.rs`) and `stop_helpers` (from `service_windows::uninstall`).
- `agent/crates/agent/src/tray/windows.rs`: the mutex (`single_instance`, taken by `tray::run`), the program watch, and the brand icon with the red dot (SPEC-BRAND-ICON, Windows).
- Deviations from the task: the helper runs the Program Files copy, not `versions\current` (point 5). The starter looks every 10 s with a 30 s settle (the Linux timing, through the shared `Starter`), so a helper starts 30 to 40 s after a session appears.
- **Only linted, not run.** This was built on Linux. Every Windows-only part compiles and passes `cargo clippy --workspace --all-targets --target x86_64-pc-windows-gnu -- -D warnings`, but none of it has run on Windows: the session list, `WTSQueryUserToken` and the linked token, `CreateEnvironmentBlock` and `CreateProcessAsUserW`, the running-helper lookup, the mutex, the program watch, the Win32 icon calls and `stop_helpers` at uninstall. The pure decisions (TS3, TS4, TS10 to TS13) ran on Linux.
- **Release test on Windows 10 and 11** before calling it verified: (a) install while signed in: the icon appears within about 40 s, and the agent log says "Started the tray in session N"; (b) sign out and in: one icon, not two; (c) an administrator account: the tray is not elevated (Task Manager, Details, Elevated column "No") and runs as that person, not SYSTEM; (d) a Remote Desktop session gets its own icon; (e) after a reinstall or the rescue-copy refresh, the old helper exits and a new one appears; (f) uninstall with someone signed in removes `C:\Program Files\BMuster`.

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

## Windows, version 2: one starter, the current version, no console window

**Status:** `APPROVED`, asked for 2026-11-12 after a real test of 0.4.19 on Windows 10. Replaces points 2, 3, 5, 7 and 8 of "Windows" above where they differ.

**This is security work.** It changes which program a LocalSystem service starts in other people's sessions, and which of their processes it ends.

### Problem

After a reboot and sign-in on a Windows 10 PC with 0.4.19:

1. A black console window titled `C:\Program Files\BMuster\bmuster-agent.exe` appears and stays, and no tray icon shows. The sign-in `Run` entry (`HKLM\Software\Microsoft\Windows\CurrentVersion\Run`, value `BMusterAgent` = `"<program>" tray`) starts the program, which is a console program, so Explorer gives it a console window.
2. Both the `Run` entry and the starter run the Program Files copy, which is the rescue copy and only catches up after a day of health. After an update the tray is a version behind (0.4.18 had neither `FreeConsole` nor the single-instance mutex). The starter matched helpers by path, so it never replaced that older tray.
3. When `Shell_NotifyIconW(NIM_ADD)` fails because the taskbar is not ready yet at sign-in, the tray gave up and exited; it only re-added its icon on `TaskbarCreated` after a successful start.

### Behaviour

1. **One way to start the tray: the service's starter.** The agent never writes the `Run` entry. It deletes the `BMusterAgent` value from that key when it is there: on install, on every start of the installed, launched agent (so an update cleans up 0.4.19 and earlier), and on uninstall. The starter starts the helper with `CREATE_NO_WINDOW`, so no console window ever appears.
2. **Sooner after sign-in.** The Windows starter lists the sessions every 2 s and starts a new session's helper once it has been seen for 5 s, so the icon appears within about 7 s of sign-in (Linux keeps its 10 s and 30 s). A session still gets at most one attempt a minute.
3. **The icon waits for the taskbar.** When `NIM_ADD` fails, the helper keeps its hidden window and message loop, and tries again every 2 s and on every `TaskbarCreated` until it succeeds. While the icon is not shown it skips the once-a-second `NIM_MODIFY`. After Explorer restarts, `TaskbarCreated` adds the icon again; if that fails, the 2 s retry starts again.
4. **The tray runs the current version.** Each version has its own tray program in the program folder: `C:\Program Files\BMuster\bmuster-tray-<version>.exe`, a copy of the running version's own program. On every start, the installed, launched agent (as SYSTEM) writes that copy when it is missing or differs: to `bmuster-tray-<version>.exe.new`, then renamed into place, so a half-written program is never started. It then deletes every other `bmuster-tray-*` file in the folder that is not in use (one still running is deleted at a later start). The starter starts only this version's copy, with the one argument `tray`.

   **Why a copy in Program Files, not `versions\current`.** The running version lives in `C:\ProgramData\BMuster\versions\current`, inside the data folder that holds the agent's private key; its ACL gives SYSTEM and Administrators access and nobody else (`restrict_dir`). A person's token can therefore not run it, and loosening that ACL would expose the folder that holds the key. The program folder already gives users read and execute and only Administrators, SYSTEM and TrustedInstaller write (inherited from `C:\Program Files`), so a per-version copy there runs with the person's token without changing any ACL. The rescue copy (`bmuster-agent.exe`) keeps its job and its one-day lag, because the tray no longer depends on it.

5. **Older trays are replaced.** Before it decides whether a session's helper runs, the starter looks at every process in that session (`QueryFullProcessImageNameW`, compared in any case):
   - this version's tray copy: the current helper;
   - any other `bmuster-tray-*` program in the program folder: a stale helper (an older or newer version's copy);
   - the rescue copy `C:\Program Files\BMuster\bmuster-agent.exe`, when the process is not elevated: a helper from 0.4.19 or earlier (the `Run` entry or the old starter). An elevated process there is an administrator's own command and is left alone; when its elevation cannot be read, it is left alone too;
   - anything else: not a helper.

   It ends each stale helper (`TerminateProcess`, waiting up to 5 s, so the mutex is free), logs "Closed an older tray in session N.", and then starts the current one in the same pass.

6. **Uninstall** ends every current and stale helper in every session (point 5's rules), then removes the program folder, the `Run` value, and the Start menu shortcut.
7. **Unchanged:** which sessions get a helper, the token rules, the environment and desktop, the mutex `Local\BMusterTray`, and the helper's own program watch (it still exits when another file stands at its program's path).

### Acceptance criteria

| ID   | Behaviour                                                                                                                                                                                   | Named test                                                                  |
| :--- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | :-------------------------------------------------------------------------- |
| TS14 | A new Windows session gets its first start within 7 s of being seen when polled every 2 s; Linux still waits 30 s.                                                                          | Rust `tray::starts::tests::windows_starts_soon_after_sign_in`               |
| TS15 | The icon is added at start and on `TaskbarCreated`; while it is not shown the retry timer adds it and the second timer does not modify it; once shown, retry stops.                         | Rust `tray::windows_sessions::tests::the_icon_waits_for_the_taskbar`        |
| TS16 | The tray program is `bmuster-tray-<version>.exe` in the program folder; other versions' copies and leftovers are recognised for removal, nothing else is.                                   | Rust `tray::windows_sessions::tests::each_version_has_its_own_tray_program` |
| TS17 | A process running this version's copy is the current helper; another version's copy, or the rescue copy unelevated, is stale; an elevated rescue copy or any other program is not a helper. | Rust `tray::windows_sessions::tests::older_trays_are_recognised`            |
| TS18 | The starter ends stale helpers in a session before it decides whether to start one, and starts the current one in the same pass.                                                            | Rust `tray::starts::tests::stale_helpers_end_before_a_start`                |
| TS19 | The `Run` value is named `BMusterAgent` under `Software\Microsoft\Windows\CurrentVersion\Run` (the value removed on install, start and uninstall).                                          | Rust `tray::windows_sessions::tests::the_old_sign_in_entry_is_known`        |

TS12 changes: the command line is the quoted tray copy and `tray`.

### Security notes

- The program started in a person's session is still fixed: this version's own program, copied by SYSTEM into the program folder, which ordinary users can read and run but not write. Nothing from the server, the browser or the session names it. The copy is written beside its final name and renamed into place, so a person can never start a half-written file.
- The data folder's ACL is not touched; the person's token still cannot read `versions\current` or the key.
- The starter ends only processes in a signed-in session whose program is a BMuster tray copy in the program folder, or the rescue copy running unelevated. It never ends an elevated process from the rescue copy (an administrator's own command), and when it cannot read a process's elevation it leaves it alone.
- Removing the `Run` value removes a second start path that ran the rescue copy with a console window; the starter is the only path.

### As built

- `agent/crates/agent/src/tray/windows_sessions.rs`: the pure rules (TS15 to TS17, TS19): the icon retry decisions, the tray program's name, and which processes are current or stale helpers.
- `agent/crates/agent/src/tray/starts.rs`: the `Starter` takes its settle time (Windows 5 s, Linux 30 s), and `Desktop::end_stale` runs before the running check (TS14, TS18).
- `agent/crates/agent/src/tray/windows_starter.rs`: the tray copy, its clean-up, stale helpers ended, the `Run` value removed at start, and a 2 s poll.
- `agent/crates/agent/src/tray/windows.rs`: no `Run` entry; the icon retry; `remove_sign_in_entry` used by install, start and uninstall.
- `bmuster_desktop::winsession::console::session_processes` lists a session's processes with their names; `processes_in_session` uses it.
- **Only linted, not run.** Built on Linux; the Windows parts pass `cargo clippy --target x86_64-pc-windows-gnu -- -D warnings` but have not run on Windows.
- **Release test on Windows 10:** (a) update from 0.4.19 while signed in: within a few seconds the old tray is closed (log "Closed an older tray in session 1."), a new icon appears, `Run` no longer has `BMusterAgent`, and `C:\Program Files\BMuster` holds `bmuster-tray-<version>.exe`; (b) reboot and sign in: no console window, the icon appears within about 10 s; (c) Task Manager shows `bmuster-tray-<version>.exe` as the person, not elevated; (d) restart Explorer: the icon comes back; (e) uninstall with someone signed in removes the folder.

## Windows, version 3: a Start menu shortcut without a console window

**Status:** `IMPLEMENTED (v0.4.22)` · approved 2026-11-12 (Jack: "go"), asked for 2026-11-12. Replaces the Start menu shortcut of "Windows" above.

### Problem

The Start menu shortcut `BMuster.lnk` (in `C:\ProgramData\Microsoft\Windows\Start Menu\Programs`) points at the rescue copy `C:\Program Files\BMuster\bmuster-agent.exe` with `tray --open`. That program is a console program, so Explorer gives it a console window, which flashes up before the browser opens. Since 0.4.20 the tray itself never runs that way (the starter uses `CREATE_NO_WINDOW`), but a shortcut cannot ask for that, and there is no GUI program to point at. Writing the shortcut also needed PowerShell and `WScript.Shell`.

### Behaviour

1. **An Internet Shortcut to the local page.** `tray --open` does one thing: open the local page's address (`https://localhost:<port>/`) in the browser. The shortcut now does the same directly: `BMuster.url`, an Internet Shortcut whose `URL` is that address and whose icon is the rescue copy's (`IconFile=C:\Program Files\BMuster\bmuster-agent.exe`, `IconIndex=0`; that path never changes between versions). The browser opens it; no program of ours runs, so no console window. The agent writes the file itself (no PowerShell).
2. **Kept current.** On install the shortcut gets the default port (a fresh install has no local page setting). On every start of the installed, launched agent, as the tray status starts, the worker compares the file with what it would write for its actual port: a missing or different file is written beside its name and renamed into place; an identical one is left alone. So an update or a changed local page port fixes it.
3. **The old shortcut goes.** Install and every start remove `BMuster.lnk` when it is there, so an update from 0.4.21 or earlier replaces it.
4. **Uninstall** removes `BMuster.url` and `BMuster.lnk`.
5. **Unchanged:** `bmuster-agent tray --open` still works by hand; the tray's own Open item.

Trade-off: `tray --open` refused to open a stale or missing status file; the shortcut opens the address regardless, so with the agent stopped the browser shows that nothing answers. That says the same thing more plainly.

### Acceptance criteria

| ID   | Behaviour                                                                                                                                                                   | Named test                                                                         |
| :--- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :--------------------------------------------------------------------------------- |
| TS20 | The shortcut is `BMuster.url`: `[InternetShortcut]` with the local page's address, the rescue copy's icon and index 0, in CRLF lines; the old one is `BMuster.lnk`.         | Rust `tray::windows_sessions::tests::the_start_menu_shortcut_opens_the_local_page` |
| TS21 | Refreshing removes `BMuster.lnk`, writes `BMuster.url` when missing or different (never leaving the staged file) and leaves an identical one alone; uninstall removes both. | Rust `tray::windows_sessions::tests::the_start_menu_shortcut_is_replaced`          |

### Security notes

- The shortcut's address is built from the agent's own port, always `localhost`; nothing from the server or a session changes it. The file is written by SYSTEM into the all-users Start menu, which only administrators may write.
- One fewer program path: nothing runs the rescue copy from the Start menu any more.

### As built

- `agent/crates/agent/src/tray/windows_sessions.rs`: `shortcut_text`, `refresh_shortcut`, `remove_shortcuts` (TS20, TS21; plain file operations, so they run on Linux).
- `agent/crates/agent/src/tray/windows.rs`: `refresh_start_menu_shortcut` used by install (default port) and by `tray::publish` at every worker start (actual port); uninstall removes both files. The PowerShell `WScript.Shell` call is gone.
- `agent/crates/agent/src/tray/status.rs`: `management_url`, shared by the tray status and the shortcut.
- **Only linted, not run on Windows.**
- **Release test on Windows 10:** (a) update from 0.4.21: the Start menu's "BMuster" entry opens the local page in the browser with no console window, and `BMuster.lnk` is gone; (b) the entry shows the BMuster mark; (c) uninstall removes it.

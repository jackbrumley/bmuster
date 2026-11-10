# SPEC-TRAY-SESSIONS: The tray in every signed-in desktop

**Status:** `IMPLEMENTED (v0.4.8)` · Approved by Jack, 2026-11-10. Extends SPEC-AGENT-TRAY.

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
7. **Windows** is unchanged: see Open questions.

## Acceptance criteria

| ID  | Behaviour                                                                                                                                      | Named test                                                             |
| :-- | :--------------------------------------------------------------------------------------------------------------------------------------------- | :--------------------------------------------------------------------- |
| TS1 | Only user-class Wayland or X11 sessions, active or online, of real users (not greeters, root, nobody or odd names) get a helper, once per uid. | Rust `tray::starter::tests::which_sessions_get_a_helper`               |
| TS2 | The start command is the fixed `systemd-run` user-manager call with the fixed program and the one argument `tray`.                             | Rust `tray::starter::tests::the_start_command_is_fixed`                |
| TS3 | A person whose helper already runs gets no start; a new one waits 30 s; a person who signed out is forgotten.                                  | Rust `tray::starter::tests::once_per_user`                             |
| TS4 | A failed or exited helper is started again at most once a minute.                                                                              | Rust `tray::starter::tests::at_most_once_a_minute`                     |
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

1. **Windows has the same gap.** The tray starts from the `HKLM\…\Run` key at sign-in, so people already signed in get no icon until they sign in again. Closing it means `WTSEnumerateSessions`, `WTSQueryUserToken` and `CreateProcessAsUserW` from the service, once per session, with a per-session single-instance mutex in the helper. That cannot be tested on this Linux build machine, so it is left for a Windows pass.
2. **Desktops without a systemd user session** (some X11 window managers) do not import `DISPLAY` into the user manager. The icon still shows (it needs only the session bus), but Open and Copy may fail until the next sign-in starts the autostart copy. Acceptable for now?

## As built

- `agent/crates/agent/src/tray/starter.rs`: session parsing and filtering, the `/proc` lookup, the rate-limited `Starter`, the `systemd-run` arguments and the worker thread (`tray::starter::start`), which runs only as root on an installed, launched agent whose current program exists.
- `agent/crates/agent/src/tray/linux.rs`: shortcuts built from `paths::CURRENT_PROGRAM`, `refresh_shortcuts` through the `move_to_opt` step runner (now shared, with a unit-name prefix per use), and the helper's single-instance lock taken by `tray::run`.
- `agent/crates/agent/src/checks/tray.rs`: the `tray` check and its pure verdict; the bus query reuses the `portal` check's `busctl` call.
- Deviation: the task suggested `systemctl --machine=<user>@.host --user is-active bmuster-tray` before starting. The `/proc` lookup replaces it, because it also sees a helper started by the autostart entry, which runs outside that unit.
- Not run natively yet: the start on Fedora 44 GNOME and the shortcut rewrite under SELinux. Record them in the release test before calling them verified.

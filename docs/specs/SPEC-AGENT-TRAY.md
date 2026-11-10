# SPEC-AGENT-TRAY: Visible installation and local management

**Status:** Implementation built for v0.3.0 candidate, 2026-11-08. Native Linux and Windows validation remains outstanding. On Linux, SPEC-TRAY-SESSIONS now has the agent start the helper in desktops already signed in and keep the shortcuts current at every start, replacing "self-update must not claim to install them" below.

## Security decision for review

The tray runs as the signed-in user, separately from the system service. It must never read private agent identity, signing keys, local sign-in secrets or portal restore tokens. Add a deliberately public, read-only status document containing only schema version, publication time, service process id, connection state and the configured loopback management URL. It contains no machine name, server address, user name or error detail.

On Linux the service owns `/run/bmuster` with mode 0755 and publishes `status.json` atomically with mode 0644. systemd owns the directory lifecycle through RuntimeDirectory. The service's existing sandbox remains enabled. The tray opens the fixed directory and file without following symlinks, verifies root ownership and rejects group/other writable paths, oversized content, unknown schema versions, invalid timestamps and URLs other than HTTPS on a loopback host with an explicit valid port. No status pathname comes from the browser. A failed read or expired publication means Agent not running; it never implies the machine has been unenrolled.

On Windows use a dedicated public-status directory under ProgramData: SYSTEM and administrators may write; ordinary users may only read. Validate its ownership and ACL before consuming it. Do not broaden access to the existing private data directory. This Windows path needs a native test before declaring support verified.

The status channel accepts no requests and grants no agent capability. Local management still requires its existing sign-in. A malicious user can replace their own tray process but gains no service privilege by doing so.

## Behaviour

- Left click opens the validated local management URL in the default browser. No shell command interpolation.
- Menu: connection status, Open local management, Copy local URL. No Stop service or Uninstall action.
- Status: Connected when the live server socket is connected; Reconnecting after prior contact while disconnected; Offline before successful contact; Agent not running when publication is missing or stale. Display the last publication time if a status read fails.
- Poll at most every five seconds. Expire publications after twenty seconds. A stale URL is not opened or copied.
- Publish only after local management has successfully bound its actual configured port. The default port is not assumed by the reader.
- Linux uses StatusNotifierItem, following Voquill's interaction pattern. Windows uses its native notification area. No Tauri webview is needed.
- Install a user-session autostart entry and an applications-menu shortcut. A tray-host-free GNOME desktop still has the shortcut; report missing tray support without claiming that the service is absent.
- User sign-out, closing the tray and a failed tray host leave the service running. Never start the tray as root, SYSTEM or inside the service's hidden session.
- Installer integration owns shortcuts and autostart entries and removes only BMuster-owned entries on uninstall. Existing installations may need the administrator installer once to acquire these entries; agent self-update must not claim to install them.

## Acceptance criteria

| ID  | Behaviour                                                                                                                                            | Named test                                                                              |
| :-- | :--------------------------------------------------------------------------------------------------------------------------------------------------- | :-------------------------------------------------------------------------------------- |
| T1  | Click and Open invoke the browser with the configured loopback URL as one argument; Copy uses the same URL; stale or invalid documents disable both. | Rust `tray::tests::actions_require_valid_status`                                        |
| T2  | Reject non-loopback URLs, credentials, fragments, unexpected paths, invalid ports, oversized documents and expired/future publications.              | Rust `tray::status::tests::reject_untrusted_status`                                     |
| T3  | Atomic publication exposes only the documented fields and reports socket transitions correctly.                                                      | Rust `tray::status::tests::publish_connection_transitions`                              |
| T4  | Unprivileged readers cannot alter the status document or obtain identity, keys or local codes through it.                                            | Linux scratch install permission test; Windows native ACL test                          |
| T5  | Autostart uses the installed executable with a dedicated tray command; application shortcut opens management without requiring a tray host.          | Rust installer tests `tray_shortcuts_and_autostart`                                     |
| T6  | A missing tray host permits later registration and leaves the management shortcut usable.                                                            | DBus scratch test `tray_host_appears_later`                                             |
| T7  | Closing the tray and ending the user session leave the system agent running.                                                                         | Scratch service integration `tray_exit_does_not_stop_agent`; native Windows manual test |
| T8  | Local management still demands its ordinary authentication after opening from the tray.                                                              | Existing local-page authentication tests plus scratch click smoke                       |

## Changes and release checks

No database migration, new public HTTP route or change to remote session permissions. Add agent tray/status modules, native backends, installer entries and bounded status publication alongside local-page startup. Test first, then implement, run full verify, align server and Rust versions and add changelog notes. Mark native tests that were not run explicitly. Source guidance: Voquill's `src-tauri/src/app/tray/`; write BMuster's implementation for its service architecture rather than copying its Tauri app lifecycle.

## As built

- The service publishes a short-lived, atomic status document after its local
  management listener is ready. Linux readers verify the root-owned runtime
  directory and file; Windows readers validate the ProgramData ACL. The
  document contains connection state, timestamp, PID and a validated loopback
  URL only.
- `bmuster-agent tray` runs as the signed-in user. Linux uses StatusNotifier
  through `ksni`; Windows uses the native notification area. Both open or copy
  the loopback URL and expose connection state. Neither exposes stop or
  uninstall actions.
- The administrator installer adds Linux autostart/application entries and
  Windows logon/Start Menu shortcuts; uninstall removes those owned entries.
- Unit coverage includes status validation/transitions, Linux symlink and
  writable-path rejection, and shortcut contents. Windows ACL/tray lifecycle,
  DBus host recovery, and installed-package click-through tests have not been
  run natively. Do not describe those as verified until the manual release
  test is recorded.

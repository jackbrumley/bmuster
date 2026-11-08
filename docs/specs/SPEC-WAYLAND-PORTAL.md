# SPEC-WAYLAND-PORTAL: Signed-in Linux desktop access

**Status:** Implementation built for v0.3.0 candidate, 2026-11-08. Native Fedora/GNOME and KDE portal validation remains outstanding.

## Scope and security decisions

This is security work: capture and input cross from the privileged system agent into a signed-in user's desktop. The first implementation supports a signed-in Wayland session with local portal approval and remembered access where the desktop supports it. It cannot capture a Wayland greeter, bypass a locked session's compositor policy or promise uninterrupted capture across sign-out. Keep the existing browser session open with a truthful unavailable reason when no supported screen is present.

The Fedora shell's exit code 208 is a separate PTY/systemd issue. Do not change SELinux, sandbox policy or terminal permissions to implement Wayland. Diagnose it from the failed transient unit's journal and add a regression test for the actual cause.

The existing approved specification stores portal restore tokens root-only, per uid. Keep that policy. The helper receives only the restore token relevant to its own uid through inherited private pipes; it never receives the agent identity key, server credentials or local-management codes. The root agent continues to verify session tickets, connect to the signed server stream and enforce watch/control permissions.

## Helper and lifecycle

1. Identify seat0's active user/session through logind. Validate uid and session state before launching; never derive launch arguments from browser-supplied paths, names or environment.
2. Start the capture helper as that uid in its user session, with the validated runtime directory and session bus. Use private inherited pipes tied to the launched process; no public command socket or browser-triggered arbitrary execution. Give the transient helper a bounded lifecycle and terminate it when its remote sessions end, the active user changes or the service stops.
3. Use RemoteDesktop plus ScreenCast in the same portal session for control, and ScreenCast only for watch. Watch never selects input devices or constructs an input injector. Portal approval is additional to BMuster's permissions, not a replacement.
4. Follow the portal's persistence contract: a successful Start returns a replacement restore token; persist it immediately, root-only, without logging it. Keep watch/control authorisations distinct. A missing or revoked token returns Needs approval; do not repeatedly open approval prompts after denial.
5. Obtain the restricted PipeWire remote descriptor from the portal. Consume only granted streams. Negotiate bounded pixel dimensions and supported formats; validate dimensions, stride and buffer lengths before producing the existing BGRX frame type. Bound the frame queue and drop superseded frames under backpressure.
6. Use the existing JPEG tile encoder and relay without server video decoding. Stream selection, resize and display changes must refresh layout and request a keyframe. Forward input only for the granted control session and release held keys/buttons on every shutdown or desktop switch.
7. Request approval only after an explicit console action. Show Needs approval, Approval pending, Approved, Approval declined/revoked and Unsupported greeter truthfully. Pending requests time out and cancel their portal session. Avoid blocking the agent control channel while a user decides.
8. Use the compositor's sharing indication and an explicit local disconnect action for active access. The tray may expose the local management page, but absence of a tray host must not hide the sharing notice or prevent disconnect.

The portal and PipeWire capture backend must be packaged and checked on supported Linux targets. Missing runtime libraries must report a Wayland capability error while inventory, terminal, files and X11 keep running; do not introduce a mandatory shared-library dependency that prevents the generic agent starting. Pin any new Rust dependencies exactly. Voquill provides portal input and token-rotation guidance, not an existing PipeWire screen-capture implementation.

## Acceptance criteria

| ID  | Behaviour                                                                                                                                                           | Named test                                                                      |
| :-- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------ | :------------------------------------------------------------------------------ |
| W1  | Select only the active user's session; greeter, no user and user switching produce the correct state and tear down the old helper.                                  | Rust `wayland::supervisor::tests::active_session_lifecycle`                     |
| W2  | Watch requests no input and rejects every injected key, pointer and clipboard command. Control requires the existing ticket permissions and granted portal devices. | Rust `wayland::permissions::tests::watch_cannot_control`                        |
| W3  | Explicit approval opens one prompt; denial, cancellation, revocation and timeout close it without a prompt loop.                                                    | Rust `wayland::portal::tests::approval_lifecycle`                               |
| W4  | Persist replacement restore tokens per uid and permission scope with private permissions; no token appears in logs, status or browser replies.                      | Rust `wayland::tokens::tests::rotation_and_isolation`                           |
| W5  | Reject malformed, oversized, truncated and mismatched frames; preserve BGRX row layout and bound queued frames.                                                     | Rust `wayland::frames::tests::validate_and_bound_frames`                        |
| W6  | Pipe closure, helper death, service shutdown and sign-out release input and descriptors and leave no helper process behind.                                         | Scratch helper integration `wayland_helper_cleanup`                             |
| W7  | Desktop UI presents approval and unavailable states, explicit Ask for approval, monitor choice and reconnect without granting control to a watcher.                 | `wayland-desktop.svelte.test.ts`                                                |
| W8  | Missing portal/backend/library produces a capability error without preventing ordinary agent startup or X11 sessions.                                               | Rust `wayland::tests::missing_runtime_isolated`                                 |
| W9  | GNOME/Fedora and KDE native tests: approve, view, control, disconnect, token reuse, revoke, resize, switch user and sign out.                                       | Native test report in As built; no claim of success based solely on compilation |

## Routes, schema and release

No database migration is planned. Extend the existing typed session and agent control contracts with approval actions/states, using the existing authenticated guards, access service and signed ticket checks. Specify exact message shapes in the implementation before tests; validate both ends and retain bounded message sizes. No new agent inbound network port.

After approval: write failing named tests, implement helper and capture, run full verify, build signed Linux and Windows artifacts, run release workflow in dry-run mode and install-test the package. Native Fedora validation is required before calling Wayland support verified. Publish a new version only after the agreed release scope passes its gates. Server self-update is tracked separately in SPEC-SERVER-UPDATES and is not implemented by this work.

## References

- Existing SPEC-DESKTOP section 6.3.
- Voquill `src-tauri/src/platform/linux/wayland/input.rs`.
- https://flatpak.github.io/xdg-desktop-portal/docs/doc-org.freedesktop.portal.RemoteDesktop.html
- https://flatpak.github.io/xdg-desktop-portal/docs/doc-org.freedesktop.portal.ScreenCast.html

## As built

- The agent detects the active signed-in Wayland session on seat0 and starts a
  short-lived helper as that user through a transient systemd unit. The helper
  creates the ScreenCast portal session; control mode also requests Remote
  Desktop keyboard and pointer devices. Watch mode requests no input devices.
- The helper receives only its user/scope restore token over its private
  process pipe. Replacement tokens are persisted under the agent data directory
  with private permissions. A system-installed helper copy under `/run/bmuster`
  is root-owned and contains no credentials.
- PipeWire frames are read by the user's GStreamer process, PNG-framed over the
  private pipe, dimension/size checked, and converted into the existing desktop
  frame path. The pipeline is bounded to one queued frame and 15 frames per
  second. GStreamer and the PipeWire plugin are runtime requirements; their
  absence reports a Wayland capability error without preventing agent startup.
- The UI exposes approval-needed/pending/declined states and an explicit
  approval action. Locked Wayland sessions and greeters are reported
  unavailable; this implementation does not capture them. Unlocking at the
  machine is required before sharing resumes.
- Unit tests cover session parsing/lifecycle, token rotation/isolation, helper
  display selection, frame bounds and pointer coordinate mapping. No native
  portal was available during implementation, so approval persistence,
  capture, input, revocation, resize and sign-out still require the Fedora
  release test. Fedora shell exit code 208 remains a separate unresolved
  terminal issue and is not claimed as fixed here.

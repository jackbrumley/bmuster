# SPEC-DESKTOP: Remote desktop sessions

**Status:** `PHASE 1 BUILT FOR LINUX X11; WINDOWS HELPER BUILT, NOT YET RUN ON WINDOWS` (2026-11-08, section 17; H.264 and later phases not built; version bump and changelog left for the release step, as for SPEC-SESSIONS) · approved 2026-11-07 · **Date:** 2026-11-07 · Builds on the generic session tickets and binary relay (SPEC-SESSIONS and the terminal and files plan). Design inputs: `docs/concept.md` §5, `docs/access-and-sign-in.md` §1, the remote desktop research report approved 2026-11-07.

## 1. Problem

The Desktop tab is a prototype frame with no screen in it. IT staff need to watch and control a machine's screen from the console, on a phone or a desktop browser, unattended, including at the lock and sign-in screens, over port 443 only. The person at the machine must be told while someone is connected, and must be able to end it.

**Out of scope (later specs or later phases of this one):** session recording, shared streams for several viewers, privacy mode (blanking the local screen), file drag-and-drop onto the screen, macOS capture, peer-to-peer transport.

## 2. Acceptance criteria

| #   | Criterion                                                                                                                                                                                                                                                                                        | Test                                                               |
| :-- | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :----------------------------------------------------------------- |
| R1  | The Desktop tab opens a live view of the machine's screen on a canvas. Linux X11 and Windows in phase 1; each later platform as its phase lands.                                                                                                                                                 | `desktop.svelte.test.ts`, agent `x11_capture` tests, e2e `desktop` |
| R2  | Opening a desktop session uses the generic flow with kind `desktop`: `POST /api/machines/[id]/sessions`, a server-signed ticket, `session-open` to the agent, the agent's own session socket, the browser's short-lived socket ticket, byte-blind relay.                                         | `session-ticket.test.ts`, `relay.test.ts`                          |
| R3  | Who may: `desktop-view` watches, `desktop-control` watches and controls. The ticket names exactly the permissions granted; a person with control may ask for a watch-only session. The agent refuses input, clipboard and special keys on a watch-only ticket (section 7).                       | `sessions.test.ts`, agent `permissions` tests                      |
| R4  | Frames use the binary format in section 4. The agent sends a keyframe at start, on a display switch, on a resize, on a quality change and on request.                                                                                                                                            | `frame.test.ts`, agent `frame` tests, shared golden fixtures       |
| R5  | Pacing: the browser acknowledges frames; the agent never has more than the window of unacknowledged frames in flight and skips capture ticks instead of queueing. A slow viewer gets a lower frame rate, never a growing delay.                                                                  | agent `pacing` tests, e2e `desktop` (throttled)                    |
| R6  | Phase 1 video is JPEG (or WebP) tiles: 64×64 tiles, only changed tiles sent. Phase 2 adds H.264 decoded with WebCodecs; JPEG stays as the fallback when the browser or the machine has no H.264.                                                                                                 | agent `tiles` tests, `decoder.test.ts`                             |
| R7  | Input: mouse (move, buttons, wheel), trackpad and touch modes on phones, keyboard by position or by character, AltGr handled, release-all when the viewer loses focus or the session ends (section 6).                                                                                           | `input.test.ts`, agent `x11_input` tests                           |
| R8  | Displays: the agent lists displays; the viewer picks one; switching rebuilds capture and sends a keyframe. All screens at once: SPEC-DESKTOP-ALL-SCREENS.                                                                                                                                        | agent `displays` tests, `desktop.svelte.test.ts`                   |
| R9  | Clipboard: text only, push (browser to machine) and pull (machine to browser) buttons, up to 1 MB, control only. Automatic sync later.                                                                                                                                                           | agent `clipboard` tests, `desktop.svelte.test.ts`                  |
| R10 | Quality, scale and frame rate: an Auto setting plus manual choices; changes apply within one frame.                                                                                                                                                                                              | agent `settings` tests, `desktop.svelte.test.ts`                   |
| R11 | Notice: while a desktop session is open and _Show a notice while connected_ is on (the default), the machine shows a bar "<name> is connected (BMuster) · Disconnect". It is kept out of the capture where the platform allows (section 8). Pressing Disconnect ends the session and is audited. | agent `notice` tests, `audit.test.ts`                              |
| R12 | Consent: when the session's consent is `ask`, the person at the screen sees Allow / Decline. No answer in 30 s declines. When nobody is signed in, the session connects at once. No frame is captured before Allow.                                                                              | agent `consent` tests, `sessions.test.ts`                          |
| R13 | Windows: the LocalSystem service starts `bmuster-agent desktop-helper` in the console session with winlogon's SYSTEM token. The helper follows the input desktop (Default, Winlogon, UAC secure desktop) and opens its own signed session socket.                                                | agent Windows clippy target, Windows VM checklist (section 11)     |
| R14 | Wayland: signed-in sessions use the portal with a remember-until-revoked restore token. The console shows one of: _Needs one-time approval at the machine_, _Approval pending at the machine_, _Approved (remembered)_, _Wayland sign-in screen not supported_.                                  | agent `portal_state` tests, `desktop.svelte.test.ts`               |
| R15 | Each viewer has their own stream (own ticket, socket, capture and encoder). The agent allows at most 4 desktop sessions per machine and refuses the fifth with a clear message.                                                                                                                  | agent `session` tests, `sessions.test.ts`                          |
| R16 | Audit: opened, consent result, ended (with reason), disconnected at the machine, each clipboard transfer (section 9). No screen contents are stored.                                                                                                                                             | `audit.test.ts`                                                    |
| R17 | The machine's Overview and the Machines list show "In use: desktop (control) by <name>" while a session is open (SPEC-SESSIONS T8).                                                                                                                                                              | `machine-views.test.ts`                                            |

## 3. Shape

```
Browser (canvas, WebCodecs)  ⇄ /api/sessions/[id]/socket ⇄  Server relay (byte-blind)  ⇄ /agent/v1/sessions/[id] ⇄  Agent desktop session
                                                                                                                      capture → encode → frames
                                                                                                                      control ← input, clipboard
```

- **Session kind.** `desktop` is one more kind on the generic ticket: `{sid, machineId, kind: 'desktop', permissions, user: {id, name}, consent: 'unattended' | 'ask', notice: boolean, exp}`, Ed25519 over canonical JSON, 60 s expiry, single use. `notice` comes from the _Show a notice while connected_ setting.
- **Relay.** Binary frames carry video and cursor data (section 4); text frames carry JSON control (section 5). The server never parses either. The generic relay's backpressure (pause above 1 MB queued, resume below 256 KB) still applies, but pacing (section 4.3) keeps the queue far below it.
- **Reconnect.** A browser that drops reattaches within 60 s with a fresh browser ticket (generic rule). It sends `hello` again and gets a keyframe. No browser for 60 s ends the session.
- **Agent code.** All desktop code lives in its own crate, `agent/crates/desktop`, so the core agent stays small and auditable:

```
agent/crates/desktop/src/
  lib.rs           session entry point: run(ticket, socket)
  frame.rs         frame header encode, tile batches
  control.rs       control messages (serde), permission filter
  pacing.rs        ack window, frame-rate and quality controller
  capture/         x11.rs (XShm + XDamage on x11rb), dxgi.rs, gdi.rs, portal.rs, drm.rs (phase 7b)
  encode/          tiles.rs (JPEG/WebP), mf.rs, vaapi.rs, openh264.rs
  input/           keymap.rs, x11.rs (XTest), windows.rs (SendInput), portal.rs, uinput.rs
  clipboard.rs     arboard on Windows and X11; portal on Wayland
  notice/          bar and consent dialog per platform
  windows_helper.rs  service side: session watch, winlogon token, helper launch
```

- The agent crate depends on `bmuster-desktop`; message types shared with the core agent (ticket, `session-open`) stay in `bmuster-protocol`. Browser-side types live in `src/lib/domain/desktop/` (frame parser, message types) and `src/lib/schemas/desktop/` (zod contracts for control messages).

## 4. Frame format

### 4.1 Header

Every binary message from the agent starts with a 20-byte header. Integers are little-endian.

| Offset | Size | Field     | Meaning                                                                                                |
| :----- | :--- | :-------- | :----------------------------------------------------------------------------------------------------- |
| 0      | u8   | `type`    | `1` H.264 access unit, `2` tile batch, `3` cursor shape, `4` cursor position                           |
| 1      | u8   | `display` | Index into the current `displays` list                                                                 |
| 2      | u8   | `flags`   | bit 0 keyframe, bit 1 size changed (new width and height), bit 2 last part of a frame; other bits zero |
| 3      | u8   | `version` | Format version, `1`. The browser closes the session with a clear message on any other value            |
| 4      | u32  | `seq`     | Frame number, per session, starting at 1 and wrapping. Cursor messages carry the seq of the last frame |
| 8      | u64  | `pts`     | Capture time in microseconds since the session started                                                 |
| 16     | u16  | `width`   | Encoded frame width in pixels (after scaling)                                                          |
| 18     | u16  | `height`  | Encoded frame height in pixels (after scaling)                                                         |

### 4.2 Payloads

- **H.264 (`1`).** One Annex-B access unit, Constrained Baseline, no B-frames, one frame per message. A keyframe is an IDR with SPS and PPS inline. Width and height are even (the agent pads by one pixel when needed). The browser feeds it to `VideoDecoder` as an `EncodedVideoChunk` (`type: key` when bit 0 is set) with the codec string from the `stream` message.
- **Tile batch (`2`).** `count: u16`, then per tile `x: u16, y: u16, w: u16, h: u16, format: u8, length: u32, bytes`. Formats: `1` JPEG, `2` WebP, `3` solid colour (4 bytes RGBA, no image). Tiles are 64×64 on a grid from the frame's top-left; edge tiles are smaller. A keyframe covers the whole frame. A large frame may be split across several batches with the same `seq`; bit 2 marks the last one, and the browser draws and acknowledges only when it has it.
- **Cursor shape (`3`).** `id: u32, hotspotX: u16, hotspotY: u16`, then a PNG. Sent once per new shape; afterwards only the id is referenced.
- **Cursor position (`4`).** `id: u32, x: i32, y: i32, visible: u8`, in encoded-frame pixels. The browser draws the cursor over the canvas, so pointer movement costs no video. Watch-only viewers see the remote cursor this way.

### 4.3 Keyframes, pacing and acknowledgements

- **Keyframe requests.** The browser sends `{type: 'keyframe'}` on start, after a decoder error, after reattaching and after a `seq` gap. The agent answers within one frame and ignores repeats within 500 ms.
- **Acknowledgements.** After drawing a frame (all its batches), the browser sends `{type: 'ack', seq}`. Acks are cumulative: acking `seq` acks everything before it.
- **Window.** The agent keeps at most 2 frames unacknowledged (3 when the measured round trip is above 150 ms). It measures the round trip from send time to ack.
- **Drop before encoding, never after.** When the window is full, the agent skips that capture tick. Changed areas accumulate (XDamage, DXGI dirty rects), so the next frame carries every change. An encoded H.264 frame is always sent, because dropping one would break the chain until the next keyframe.
- **Frame rate.** The agent captures at most at the chosen rate (default 30 for H.264, 15 for tiles) and sends nothing when the screen has not changed. The effective rate is the lower of the chosen rate and what the acks allow.
- **Auto quality.** With quality on Auto, the agent picks the highest level the link sustains, judged from the acknowledgement round trips (section 20). Version 1 lowered the JPEG quality one step after frames waited on the window for 2 s, and raised it after 10 s with the window never full.
- **Backlog guard.** If no ack arrives for 10 s, the agent stops sending frames (cursor messages continue) and sends `{type: 'stalled'}`. A new ack or a keyframe request resumes it with a keyframe.

### 4.4 Codecs

- **Phase 1:** tiles only. JPEG via a pure-Rust encoder (`jpeg-encoder` or `zune-jpeg`, pinned exactly); WebP when the encoder crate proves small enough.
- **Phase 2 (H.264 main path):**
  - Windows: the Media Foundation H.264 encoder MFT (hardware when present, Microsoft's software MFT otherwise).
  - Linux: VAAPI through libva loaded with `dlopen`.
  - Software fallback on either: Cisco's prebuilt openh264 binary, **downloaded at run time from Cisco only, never bundled**, version and SHA-256 pinned in the agent source, kept under the agent's data folder and loaded with `dlopen`. Server setting _Allow the OpenH264 download_ (on by default). The console's licences page shows "OpenH264 Video Codec provided by Cisco Systems, Inc."
  - JPEG tiles stay as the fallback when the browser has no WebCodecs H.264 (`VideoDecoder.isConfigSupported`), the machine has no working encoder, or the download is blocked.
- **No VP8 or VP9.**

## 5. Control messages

Text frames, JSON, one object with a `type` per frame. Each side ignores unknown types (logged once), so later phases add messages without breaking older peers.

### 5.1 Browser to agent

| Type             | Fields                                                                                                                                                                                        | Needs   |
| :--------------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :------ |
| `hello`          | `codecs: ('h264' \| 'jpeg' \| 'webp')[]`, `viewport: {width, height, pixelRatio}`                                                                                                             | view    |
| `keyframe`       | —                                                                                                                                                                                             | view    |
| `ack`            | `seq`                                                                                                                                                                                         | view    |
| `select-display` | `display` (an id from `displays`, or `all` from phase 4)                                                                                                                                      | view    |
| `settings`       | `quality: 'auto' \| 'low' \| 'medium' \| 'high' \| 'extra-high'`, `scale: 'fit' \| 1 \| 0.75 \| 0.5 \| 0.25`, `maxFps: 5 \| 10 \| 15 \| 30`, `autoStart: 'high' \| 'extra-high'` (section 20) | view    |
| `pointer`        | `x`, `y` (display pixels, unscaled), `buttons` (bit mask: left 1, right 2, middle 4, back 8, forward 16)                                                                                      | control |
| `wheel`          | `dx`, `dy`, `mode: 'pixel' \| 'line'`                                                                                                                                                         | control |
| `key`            | `code` (`KeyboardEvent.code`), `key` (`KeyboardEvent.key`), `down: boolean`, `altGr: boolean`                                                                                                 | control |
| `text`           | `text` (up to 256 characters), typed as characters                                                                                                                                            | control |
| `special`        | `name: 'ctrl-alt-del' \| 'win' \| 'alt-tab' \| 'print-screen'`                                                                                                                                | control |
| `release-all`    | —                                                                                                                                                                                             | control |
| `clipboard-push` | `text` (up to 1 MB)                                                                                                                                                                           | control |
| `clipboard-pull` | —                                                                                                                                                                                             | control |
| `disconnect`     | —                                                                                                                                                                                             | view    |

### 5.2 Agent to browser

| Type           | Fields                                                                                                                                                                           |
| :------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `displays`     | `list: [{id, name, x, y, width, height, scale, primary}]`, `current`. Sent at start and whenever the layout changes                                                              |
| `stream`       | `display`, `codec: 'h264' \| 'jpeg' \| 'webp'`, `codecString` (H.264 only, e.g. `avc1.42E01F`), `width`, `height`, `scale`. Before each keyframe that changes any of these       |
| `state`        | `screen`: `{kind: 'sign-in'}`, `{kind: 'locked' \| 'desktop', user: string \| null}` or `{kind: 'unavailable', reason}`. Sent after `hello` and whenever it changes (section 16) |
| `consent`      | `state: 'asking' \| 'allowed' \| 'declined' \| 'timed-out' \| 'not-needed'`                                                                                                      |
| `wayland`      | `state: 'needs-approval' \| 'pending' \| 'approved' \| 'greeter-unsupported'`                                                                                                    |
| `clipboard`    | `text`, in reply to `clipboard-pull`                                                                                                                                             |
| `stalled`      | — (section 4.3)                                                                                                                                                                  |
| `auto-quality` | `level: 'low' \| 'medium' \| 'high' \| 'extra-high'`: the level Auto picked, after `settings` while on Auto and on every change (section 20)                                     |
| `error`        | `code: 'not-allowed' \| 'too-many-sessions' \| 'capture-failed' \| 'encoder-failed' \| 'bad-message'`, `message`                                                                 |
| `ended`        | `reason` (section 9). The agent closes the socket after it                                                                                                                       |

### 5.3 Input rules

- **Coordinates** are in the selected display's native pixels, whatever the scale, so changing scale never moves a click. The agent clamps them to the display and adds the display's origin.
- **Trackpad mode** (phones, the default there): the browser keeps a virtual pointer. One-finger drag moves it relatively; tap clicks left; two-finger tap clicks right; two-finger drag sends `wheel`; tap-and-drag holds the left button. **Touch mode:** a tap moves the pointer there and clicks. Pinch zooms the view in the browser only and sends nothing. Both modes send absolute `pointer` messages; the agent does not know which mode is in use.
- **Mouse** (desktop browsers): `pointermove` coalesced to one `pointer` per animation frame; button changes sent at once.
- **Keyboard by position** (desktop browsers, the default): the agent maps `code` to a scancode (Windows) or keycode (X11), so the remote layout decides the character. Shortcuts with Ctrl, Alt or Meta always go by position.
- **Keyboard by character** (phones, and a toggle on desktop for different layouts): printable characters go as `text`. Windows uses `KEYEVENTF_UNICODE`; X11 uses the keysym's keycode when mapped, else maps it to a spare keycode for the duration of the keystroke. Non-printing keys (Enter, Backspace, arrows, Esc, Tab, function keys) still go as `key`.
- **AltGr.** Windows browsers report AltGr as a synthetic `ControlLeft` down immediately followed by `AltRight` down. The browser holds a `ControlLeft` down for up to 10 ms; if `AltRight` follows, it drops the `ControlLeft` and sends `AltRight` with `altGr: true`. The agent presses Right Alt (scancode `E0 38`) on Windows and `ISO_Level3_Shift` on X11. In character mode, AltGr itself is never sent; the character it produces goes as `text`.
- **Release-all.** The browser sends `release-all` on `blur`, on `visibilitychange` to hidden, when the keyboard toggle closes and before a display switch. The agent tracks every key and button it pressed and releases them on `release-all`, on a display switch, on a desktop switch (Windows), and when the session ends for any reason, so no key stays stuck on the machine.
- **Special keys.** `ctrl-alt-del` uses `SendSAS` on Windows (the agent sets the `SoftwareSASGeneration` policy to allow services, and reports `error` if it cannot); on Linux it sends the key chord. The browser shows these on a menu, since the viewer's own system catches them. The menu is specified in `SPEC-DESKTOP-KEYS.md`.

## 6. Platforms

### 6.1 Linux X11 (phase 1)

- The root agent finds the active seat0 session through logind, its `DISPLAY` and its Xauthority: the user's from the session process's environment, the greeter's from Xorg's `-auth` argument.
- The desktop session runs as a thread in the agent and connects with that Xauthority. Capture: XShm `GetImage` per display rectangle, XDamage to find changed areas, on `x11rb`. Input: XTest. Clipboard: X selections through `arboard`.
- When the session switches (sign-in, sign-out, user switch), the agent reconnects to the new display and sends `displays`, `state` and a keyframe. The browser session stays open; with nothing to capture (Wayland, a text console, no session) it waits in `unavailable` with the reason (section 16).
- Development overrides: `agent-dev` and tests may set `BMUSTER_DESKTOP_DISPLAY` and `BMUSTER_DESKTOP_XAUTHORITY` to point the agent at a nested X server, or `BMUSTER_DESKTOP_SCREEN_FILE` to a file that says which screen to show (so a test can switch screens). Release builds ignore all three.

### 6.2 Windows (phases 1 and 3)

- **Service and helper.** The LocalSystem service watches the console session (`WTSGetActiveConsoleSessionId`, `SERVICE_CONTROL_SESSIONCHANGE`). For a desktop session it duplicates the SYSTEM token of `winlogon.exe` in that session and starts `bmuster-agent desktop-helper` with `CreateProcessAsUserW`. The helper runs as SYSTEM in the user's session, so it can open both the Default and Winlogon desktops.
- **Ticket hand-over.** The service verifies the ticket, then passes it to the helper over a named pipe whose ACL allows only SYSTEM, never on the command line. The helper verifies it again (signature, expiry, kind), then opens its own session socket, signed with the agent key. The pipe carries only start, stop and status; video never crosses it.
- **Following the input desktop.** On every capture tick the helper checks the input desktop. When it changes (lock, sign-in screen, UAC secure desktop), it releases all input, calls `OpenInputDesktop` and `SetThreadDesktop`, rebuilds DXGI duplication and sends `state` and a keyframe. When the console session changes (fast user switching, sign-out), the service starts a new helper and the browser reattaches; the session id stays the same.
- **Capture.** DXGI Desktop Duplication (dirty rects, pointer shape), falling back to GDI `BitBlt` when DXGI fails (RDP-attached sessions, some VMs, old drivers). Phase 1 covers the Default desktop only; phase 3 adds Winlogon, UAC and session switching.
- **Input.** `SendInput` with scancodes; `KEYEVENTF_UNICODE` for `text`.
- A helper that exits unexpectedly ends the session with reason `agent-lost`; the service logs why.

### 6.3 Linux Wayland (phase 7)

- **Policy.** On managed fleets, X11 is preferred (GDM `WaylandEnable=false`). Inventory reports each session's type, and the Machines list can filter for Wayland machines.
- **Signed-in sessions: the portal.** The agent starts `bmuster-agent desktop-helper` as the signed-in user, on the user's session bus. It opens a RemoteDesktop session with ScreenCast sources (pointer and keyboard devices), `persist_mode` remember-until-revoked, frames from PipeWire.
  - The restore token is stored root-only under the agent's data folder, one per user. Every successful restore returns a new token, which replaces the old one at once.
  - A token fails when the monitor layout changes or it is revoked; the state goes back to _Needs one-time approval_.
- **Console states** (the `wayland` message, also reported in the check-in so the tab shows them before a session):
  - _Needs one-time approval at the machine:_ no token. The tab offers **Ask for approval**, which opens the portal dialog at the machine.
  - _Approval pending at the machine:_ the dialog is open.
  - _Approved (remembered):_ a token exists; sessions connect without a prompt.
  - _Wayland sign-in screen not supported:_ the machine is at a Wayland greeter.
- **Sign-in screen: DRM/KMS with uinput** (phase 7b), only after libdrmtap's licence is checked (open question 1). Until then the state above applies.
- Clipboard on Wayland uses the portal Clipboard interface where the desktop offers it; otherwise the buttons are hidden.

## 7. Permissions on the agent

- The agent trusts only the signed ticket. A watch-only ticket carries `['desktop-view']`; a control ticket `['desktop-view', 'desktop-control']`.
- `control.rs` filters every incoming message before it reaches input or clipboard code. On a watch-only ticket, `pointer`, `wheel`, `key`, `text`, `special`, `release-all`, `clipboard-push` and `clipboard-pull` are dropped; the first one dropped gets one `error {code: 'not-allowed'}` and is logged. Clipboard pull needs control because it reads the person's data.
- The input and clipboard objects are not even created for a watch-only session, so a missed filter case cannot inject input.
- Consent comes from the ticket too: `ask` means no capture until Allow. The browser cannot change it.
- The server works out the ticket: admins unattended with control; members get the permissions from their rules, `unattended` if any rule giving the requested permission says so; share links always `ask` (when someone is signed in). _Until consent prompts exist, share-link guests get `unattended` with the notice forced on, by owner decision of 2026-11-12 (SPEC-SHARE-LINKS D1, D15)._
- Any message before `hello`, or malformed JSON, gets `error {code: 'bad-message'}`; 20 bad messages end the session.

## 8. Notice and consent at the machine

- **Notice bar.** While a desktop session is open and the ticket's `notice` is true, the machine shows a small topmost bar: "<name> is connected (BMuster) · Disconnect". With several viewers it lists every name. Drawn by the desktop code:
  - Windows: a layered topmost window, excluded from the capture with `SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE)` (Windows 10 2004 and later). On older builds it shows in the stream.
  - X11: an override-redirect window at the top centre. X11 has no capture-exclusion API (open question 3).
  - Wayland: a desktop notification with a Disconnect action.
  - Since notice version 2 (section 18) the bar folds to a small pill a few seconds after it opens, and the tray helper shows the same viewers on every desktop, including Wayland desktops where the agent cannot draw a bar.
- **Disconnect** ends every desktop session on the machine at once with reason `disconnected-at-machine`, audited with the local user's name.
- **Consent prompt** for `ask`: "<name> wants to watch your screen" or "…to control your screen (BMuster)", with **Allow** and **Decline**. No answer in 30 s declines. When nobody is signed in (sign-in screen, no session), it connects at once with consent `not-needed`. The browser shows "Waiting for <user> to allow…" meanwhile.

## 9. Audit

The generic `session-opened` and `session-ended` entries cover desktop sessions, with desktop details. New kinds are added to `src/lib/domain/activity/activity.ts`.

| Kind                              | Detail                                                                                                                                                                                   |
| :-------------------------------- | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `session-opened`                  | who, machine, kind `desktop`, mode (`watch` or `control`), consent setting, IP address, browser                                                                                          |
| `session-consent`                 | `allowed`, `declined`, `timed-out` or `not-needed`, with the local user's name when known                                                                                                |
| `session-ended`                   | duration, reason: `closed`, `declined`, `timed-out`, `disconnected-at-machine`, `no-browser`, `agent-lost`, `permission-removed`, `too-many-sessions`; frames and bytes sent; codec used |
| `session-disconnected-at-machine` | machine, local user's name, every viewer it ended                                                                                                                                        |
| `desktop-clipboard`               | direction (to or from the machine), byte count, session; never the text or a hash of it (section 21.6)                                                                                   |
| `setting-changed`                 | already exists; covers _Show a notice while connected_ and _Allow the OpenH264 download_                                                                                                 |

No screen contents, keystrokes or clipboard text are stored.

## 10. Phase plan

Sizes from the research report: S under a week, M one to two weeks, L three weeks or more.

| Phase | What                                                                                                                                                                                                                  | Size         | Criteria            |
| :---- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :----------- | :------------------ |
| 0     | This spec and the protocol: frame header, control messages, ticket permissions                                                                                                                                        | S, 2–3 days  | R2–R4               |
| 1     | End to end, one monitor, mouse and keyboard: X11 XShm and XTest; Windows service to helper (Default desktop), DXGI with GDI fallback, `SendInput`; JPEG tiles; canvas, trackpad and touch modes; notice bar and audit | L, 3–4 weeks | R1–R7, R11, R15–R17 |
| 2     | H.264: Media Foundation, VAAPI, Cisco openh264 at run time, WebCodecs decoder, keyframes, pacing; JPEG stays as fallback                                                                                              | M, 2 weeks   | R6                  |
| 3     | Windows secure desktop and session switching: Winlogon, lock, sign-in, UAC, fast user switching, Ctrl+Alt+Del via `SendSAS`                                                                                           | M, 1–2 weeks | R13                 |
| 4     | Multi-monitor: display list, switching, then the all-screens view                                                                                                                                                     | S–M, 1 week  | R8                  |
| 5     | Consent prompt: `ask` rules, timeout, connect when nobody is signed in                                                                                                                                                | S, 1 week    | R12                 |
| 6     | Clipboard and quality controls                                                                                                                                                                                        | S–M, 1 week  | R9, R10             |
| 7     | Wayland portal: ScreenCast and RemoteDesktop, PipeWire frames, restore-token store, console states                                                                                                                    | M, 2 weeks   | R14                 |
| 7b    | Wayland sign-in screen: DRM/KMS with uinput, after the libdrmtap licence check                                                                                                                                        | L, 2–3 weeks | R14                 |

The generic session tickets and binary relay (the parallel terminal and files work) must land before phase 1.

## 11. Tests

### 11.1 Unit and contract tests

- **Frame format.** Rust writes golden frames (each type, each flag, a split tile batch) to `tests/fixtures/desktop-frames/`; `frame.test.ts` parses the same bytes. Either side changing the format breaks both.
- **Agent, no display needed:** tile diff (only changed tiles, solid-colour tiles, keyframe covers all); pacing (window of 2, skip before encode, damage carried into the next frame, stall after 10 s, auto quality steps); keyframe rate limit; permission filter (a watch-only session drops every control message and never builds an injector, using a recording fake injector); key mapping tables (`code` to scancode and to X keysym); release-all after a mix of presses.
- **Server (vitest, in-memory SQLite):** ticket for `desktop` carries the right permissions and consent for admins, members (union of rules, `unattended` if any rule says so) and share links; watch-only request from a control user narrows the ticket; audit entries and reasons.
- **Browser (vitest):** AltGr detection (synthetic `ControlLeft` dropped, real Ctrl+Alt kept); release-all on `blur` and `visibilitychange`; trackpad gestures to `pointer` and `wheel`; acks after the last batch only; keyframe request after a `seq` gap; fallback to tiles when `isConfigSupported` says no.

### 11.2 Phase 1 on this Linux X11 machine, without sudo

The capture target is always a nested X server, never the real desktop.

- **The nested server.** A test helper in `agent/crates/desktop/tests/support/` starts `Xvfb` when installed, otherwise `Xephyr` (installed here; it opens a window on the current desktop, so a person can watch the test). It uses `-displayfd` to get a free display number, `-screen 1280x800x24`, `-nolisten tcp`, and `-auth <tempdir>/xauthority` with a cookie written by the test (`xauth` or a few bytes written directly). That exercises the agent's Xauthority path the same way as a real greeter.
- **Safety.** The helper refuses to run when the target display equals the test's own `DISPLAY`, so no test can inject input into the real session. Without either server, the X tests skip with a message; CI installs Xvfb.
- **Capture.** The test draws known rectangles on the nested root window with its own `x11rb` client, captures, and checks pixels; then changes a 10×10 area and checks that XDamage yields only the touching tiles.
- **Input.** The test maps a window that listens for pointer and key events. XTest moves and clicks are checked with `QueryPointer` and the received events; `KeyA` by position gives keycode for `a`; `setxkbmap -display :N de` then AltGr+Q gives `@`; `text` of a character missing from the keymap gives the right keysym; release-all leaves no modifier set.
- **Clipboard.** `xclip -display :N` sets and reads the selection on the nested server for push and pull.
- **Notice bar.** The test finds the override-redirect window by its name with `QueryTree`, clicks Disconnect through XTest, and expects `ended {reason: 'disconnected-at-machine'}`.
- **End to end.** The scratch server and `agent-dev` from the terminal plan (scratch `DATABASE_PATH`, `RELEASES_PATH`, data folder), with `BMUSTER_DESKTOP_DISPLAY=:N` and `BMUSTER_DESKTOP_XAUTHORITY` set. A Playwright script signs in, opens the Desktop tab, waits for the canvas, samples a pixel against the colour drawn on the nested server, clicks on the canvas and checks the nested pointer moved, types a word into a test window, and throttles the network to check that the frame rate drops without the delay growing. H.264 runs need Chrome (`channel: 'chrome'`), because Playwright's own Chromium has no H.264 decoder.
- Never point anything at `agent/dev-data`, `data/`, `.env`, `/opt/bmuster` or `/var/lib/bmuster`.

### 11.3 Tested elsewhere

- Windows: cross-checked with the Windows clippy target on every change; then a Windows 11 VM checklist: connect at the desktop, lock and unlock, sign-in screen, UAC prompt, fast user switching, RDP-attached (GDI fallback), Ctrl+Alt+Del, notice bar absent from the stream, Disconnect.
- VAAPI on a machine with an Intel or AMD GPU (needs only the `render` group, not sudo); openh264 with the download allowed and blocked.
- Wayland: GNOME 46+ and KDE Plasma 6 VMs for the portal states and token reuse after reboot.

## 12. Code reuse and licences

- **RustDesk code is rewritten, with credit notices** where we follow its logic (helper launch, desktop following, session watch, video pacing). Only a stripped DXGI and GDI capture module is vendored into `capture/`, treated as AGPL-3.0 plus MIT, with both notices kept. BMuster never depends on RustDesk's `scrap` or `enigo` crates.
- **Voquill** input code (Jack's, AGPL-3.0-only) may be copied, after checking with `git blame` that Jack wrote the copied lines (Voquill has one outside contributor).
- **MeshCentral** (Apache-2.0) gives ideas: AltGr detection, release-all on blur, touch handling, quality controls. Copied code keeps the Apache notice.
- Crates, pinned exactly: `windows`, `x11rb`, `ashpd`, `pipewire`, `arboard`, `evdev` or `uinput`, a JPEG encoder. Each new crate's licence is checked before it is added.

## 13. Decisions (2026-11-07)

1. **Video:** JPEG/WebP tile diff in phase 1. Then H.264 as the main path: Media Foundation on Windows, VAAPI on Linux, and Cisco's openh264 binary downloaded at run time only, never bundled. JPEG stays as the fallback. No VP8/VP9.
2. **Windows:** the LocalSystem service starts `bmuster-agent desktop-helper` in the console session with winlogon's SYSTEM token. It follows the input desktop (lock, sign-in, UAC). The helper opens its own signed session socket.
3. **Code layout:** the desktop code lives in its own crate, `agent/crates/desktop`.
4. **RustDesk code:** rewrite with credit notices. Vendor only a stripped DXGI/GDI capture module, treated as AGPL+MIT. Never depend on RustDesk's `scrap` or `enigo` crates. Voquill's input code (Jack's, AGPL-3.0-only) may be copied after checking who wrote those lines.
5. **Wayland:** X11 preferred on managed fleets. The portal with remember-until-revoked restore tokens for signed-in sessions, with the console states _needs one-time approval_, _pending_, _approved_ and _sign-in screen not supported_. DRM/KMS with uinput for the sign-in screen only after libdrmtap's licence is checked.
6. **Viewers:** one stream per viewer for now; shared streams later.
7. **Notice at the machine:** a bar saying "<name> is connected (BMuster) · Disconnect", on by default, kept out of the capture. Disconnect is audited. Consent prompts for `ask` rules: Allow/Decline, declines on timeout, connects at once when nobody is signed in.

## 14. Open questions

1. **libdrmtap's licence.** It decides whether phase 7b can load it with `dlopen`, or whether DRM/KMS capture must be written from scratch. Phase 7b waits for the answer.
2. **Locked screen with an `ask` rule.** Someone is signed in but away, so the prompt times out and declines. Should a locked screen count as "nobody to ask" (MeshCentral's _auto-accept if locked_), as a server setting?
3. **Notice bar on X11.** X11 cannot keep a window out of the capture. Accept that viewers see the bar (it is small and at the top), or blank its rectangle in the stream?
4. **Idle timeout for desktop sessions.** Reuse the terminal's 60 minutes with no input, or none for watch-only sessions?
5. **Session limit.** Is 4 desktop sessions per machine right, or should it be a server setting?

## 15. As built: phase 1 wiring, Linux X11 (2026-11-07)

| #   | Where                                                                                                                                                                                                                                                                                            | Tests                                                                                           |
| :-- | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :---------------------------------------------------------------------------------------------- |
| R1  | Page `machines/[id]/desktop/`: `desktop-session.svelte.ts` (frames, acks, messages), `desktop-canvas.ts` (tiles with `createImageBitmap`, solid tiles with `putImageData`, cursor on its own canvas). Agent `sessions/desktop.rs` runs `bmuster_desktop::run` on its own thread beside the pump. | `desktop.svelte.test.ts`, agent `sessions::desktop` tests, end to end                           |
| R2  | Ticket purpose `{kind: 'desktop', consent, notice}` (needs `desktop-view`); `openDesktopSession`; the relay passes desktop text frames both ways unread and replays nothing on reattach.                                                                                                         | `session-ticket.test.ts` and the desktop vector, `relay.test.ts`, `sessions.test.ts`            |
| R3  | The ticket carries exactly `['desktop-view']` or `['desktop-view', 'desktop-control']`; a person with control may pick Watch only. The page sends no input on a watch session; the agent never builds an injector for one.                                                                       | `sessions.test.ts`, `desktop.svelte.test.ts`, agent `a_watch_session_sends_frames…`             |
| R4  | `src/lib/domain/desktop/frame.ts`; golden frames in `tests/fixtures/desktop-frames/` written by the desktop crate's `frame_fixtures` test with a manifest both sides check. Keyframe request on hello, after a gap and after a frame that would not decode.                                      | `frame.test.ts`, agent `frame_fixtures`, `desktop.svelte.test.ts`                               |
| R5  | Acks after a frame's last batch is drawn; the stalled message shows "The picture is paused" with Resume (a keyframe request).                                                                                                                                                                    | `desktop.svelte.test.ts`                                                                        |
| R7  | `input.ts` (letterboxing, AltGr filter, trackpad and touch gestures), `screen-input.ts` (listeners, mouse moves once per animation frame, release-all on blur and when hidden), `key-bar.svelte` for phones (Esc, Tab, Ctrl, Alt, Win, arrows; the phone keyboard's characters go as `text`).    | `input.test.ts`, `desktop.svelte.test.ts`, end to end                                           |
| R10 | `desktop-settings.svelte`: quality, scale, frame rate as one `settings` message.                                                                                                                                                                                                                 | `desktop.svelte.test.ts`                                                                        |
| R11 | `bmuster-desktop` `notice/`: one override-redirect window at the top centre of the X screen, named "BMuster notice", drawn with the server's `fixed` font, listing every viewer; Disconnect sends every desktop session `End(disconnected-at-machine)`.                                          | desktop `notice` unit tests, `notice_bar_disconnect_through_xtest_ends_the_session`, end to end |
| R15 | `SessionSlot` (4 per machine); the fifth gets `error {code: 'too-many-sessions'}` and `ended {reason: 'too-many-sessions'}`.                                                                                                                                                                     | crate `session` tests                                                                           |
| R16 | `session-opened` / `session-ended` with type `desktop`, mode, consent, codec and the end reason; `session-disconnected-at-machine` (system actor) naming the viewer and mode.                                                                                                                    | `sessions.test.ts`                                                                              |
| R17 | `inUse` carries the mode: "In use: desktop (control) by <name>".                                                                                                                                                                                                                                 | `machine-views.test.ts`, `relay.test.ts`                                                        |

**Different from the spec or decided while building**

- **Consent `ask` is refused, not connected.** Until the consent prompt (phase 5), the server refuses a desktop session whose rule for the asked permission says `ask` (409, with the reason), the page says so instead of offering Connect, and the agent refuses an `ask` ticket before it opens the screen.
- **The agent's `ended` is the session's last word.** The relay reads `{type: 'ended', reason}` from a desktop agent as it reads `exited` from a terminal, ends the session with that reason and tells the browser in plain words. Desktop end reasons joined the session end reasons.
- **One audit entry per viewer for Disconnect at the machine**, not one listing all viewers, and without the local user's name (the X11 session does not report it yet).
- **Idle:** a desktop viewer's own messages (including acks) count as activity, so a watched desktop does not end after 60 minutes (open question 4 stays open for a real idle rule).
- **The viewer starts the session** with Connect or Watch only rather than on opening the tab, because starting one puts a notice on someone's screen.
- **Notice bar on X11 shows in the stream** (open question 3); with its window name it is easy to blank later. Windows has no bar yet: the notice code logs there (TODO with the Windows helper).
- **The choice comes back after every end.** After Disconnect, an end at the machine or any other end, the tab offers Connect and Watch only again (Watch only alone without `desktop-control`); the page no longer has a "Connect again" that reused the last mode. Only a reattach (a reload, or a dropped connection within the minute) keeps the mode, which the tab saved with the session. Tested in `desktop.svelte.test.ts` ("offers both choices again…", "keeps the mode when it reattaches…").
- **Changing mode is a new session.** A ticket names its permissions (R3), so Watch only to control is not a live switch: "Take control" (and "Switch to view only") ends the running session and opens one in the other mode, with an opened and an ended audit entry each time. Only offered to someone with `desktop-control`.
- **Full screen has its own bar** (`full-screen-bar.svelte`): the page's bar is outside the full-screen element, so a small bar floats at the top centre of the screen with Leave full screen, the mode (with the switch), picture settings (shown under it), Ctrl+Alt+Del on Windows machines (disabled until the Windows helper) and Disconnect. It shows on entering full screen, when the mouse comes within 56 px of the top or a finger taps the screen, stays while the mouse is on it or the settings are open, and hides after 3 s. `screen-input.ts` sends only events whose target is the screen itself, so the bar's clicks and keys never reach the machine, and each action gives the keyboard back to the screen. The button state follows `fullscreenchange`, so Esc or the browser leaving full screen keeps it right, and a session that ends in full screen leaves it so the choices show. Phones and tablets get a movable controls button instead of this bar (SPEC-DESKTOP-FLOATING).
- **Session socket code shared:** `src/lib/runes/session-link.svelte.ts` now carries the ticket, socket, reattach and server control messages for both the terminal and the desktop.
- **Not built in this phase:** pinch zoom on phones, clipboard (phase 6), `special` keys other than the key bar's (Ctrl+Alt+Del says "Windows only, coming later"), display switching was wired but only tested with one display, the Windows helper and bar.

**End to end** (scratch server on port 47700, the debug agent with `BMUSTER_DESKTOP_DISPLAY=:95`, a headless Xvfb with its own cookie, `xsetroot`, `xclock` and `xedit` on it, Playwright Chromium): the canvas showed the root colour and the xedit window; a click into xedit and typing changed the screen; a watch-only tab showed View only, received frames and sent no input message; a reload came back to the same session with the picture; Disconnect on the notice bar (clicked through the control session) ended both sessions with "Someone at the machine pressed Disconnect."; the audit had the opened, ended and disconnected-at-machine entries. Measured at 1280 px (stream 961×601, fit): an idle screen with a ticking clock 1 fps and about 3 KB/s; the whole background changing 10 times a second (a fine plaid, worst case for JPEG) 9.9 fps and about 3.2 MB/s, with the desktop crate built optimised (an unoptimised debug build managed 4 fps). Screenshots at 390 and 1280 px, light and dark.

**Not tested here:** Windows (type- and clippy-checked only), the real display under GDM or LightDM (seat0 discovery, the greeter's Xauthority), a throttled network (R5's falling frame rate), several displays, and the release build's behaviour beyond the debug build with an optimised encoder.

## 16. As built: following the screen, Linux X11 (2026-11-08)

The desktop follows whatever the physical screen shows, like VNC in service mode: the sign-in screen, someone's desktop, and a switch between them, without ending the browser session. Before this, signing out or switching user made capture fail and the session ended with `agent-lost`.

**Design**

- **Generic part** (`bmuster-desktop`, platform-neutral): `follow.rs` has the `ScreenWatch` trait. `look()` says what the screen shows now (a `Look`: a `key` that changes whenever it is another screen, and the `DesktopState`); `open()` opens capture, input and the notice target on it (a `Platform`). `DesktopSession::following(mode, watch, now)` (in `session/following.rs`) looks once a second. A new key: release every held key and button, drop the old capturer and injector, open the new screen (the injector only for a control session), move the notice bar, and send `displays`, `state` and a keyframe (the `stream` message comes again first). The same key with a new state (lock, unlock): only `state`. A capture failure no longer ends a following session: it closes the screen and looks again at once when the screen had worked for a second, otherwise at the next look, so a broken screen is reopened at most once a second. While nothing is open the loop sleeps until the next look and sends no frames; input is dropped (there is no injector).
- **`state` message, generic for every platform:** `screen: {kind: 'sign-in'} | {kind: 'locked', user} | {kind: 'desktop', user} | {kind: 'unavailable', reason}`. `user` is the account name or null. It replaced the first draft's `desktop: 'default' | 'winlogon' | 'secure' | 'greeter'` fields, which nothing read. The Windows helper reports the same states (Winlogon with nobody signed in is `sign-in`, the lock screen `locked`, the Default or UAC desktop `desktop`).
- **Linux** (`capture/x11_follow.rs`): `LogindWatch` runs `loginctl show-seat seat0 -p ActiveSession` and `show-session` (Type, Class, Display, Name, User, State, LockedHint) on every look and reads them with the pure `look_at`. An X11 session with a display is a screen, keyed by session id and display: class `greeter` is `sign-in`, `LockedHint=yes` (or class `lock-screen`) is `locked`, else `desktop`. Otherwise it waits with a reason: "Wayland sign-in screen not supported yet", "Wayland desktop not supported yet", "Text console", "The session on the screen is closing", "No session is on the screen", "Cannot find the screen (seat0): …". `open()` finds the Xauthority (the session's processes, then the X server's `-auth` argument, which covers LightDM's `/var/run/lightdm/root/:0` and SDDM, then GDM's `/run/user/<uid>/gdm/Xauthority`, then `~/.Xauthority`) and builds the capturer, the XTest injector factory and the notice target with `x11_platform`. LightDM reuses the greeter's X server for the user session, so the display can stay `:0` across a switch; the key changes with the logind session, so everything is reopened anyway.
- **Agent wiring:** `open_console()` returns `Console::Following(LogindWatch)` on Linux and `Console::Fixed(open_platform())` elsewhere; `sessions/desktop.rs` builds `DesktopSession::following` or `DesktopSession::new` from it. A following session never fails to start: with nothing to show it opens in `unavailable`.
- **Notice bar:** the bar is global (one per machine). `notice::keep_on(screen)` moves it: a following session calls it when it opens a screen (the bar closes on the old display and opens on the new one), with `None` when there is no screen, and on every look of the same screen, which brings the bar back if its X server restarted. `show(None, …)` registers a viewer on the screen a following session placed. A screen the bar cannot open on is retried every 10 s. On Windows the notice target is now a unit struct instead of `()`.
- **Console:** `src/lib/domain/desktop/screen.ts` (`DesktopScreen`, `screenLabel`) and the zod `screenSchema`. The Desktop tab shows a status line beside the frame rate: "Sign-in screen", "jack's desktop", "jack's desktop · locked", and for `unavailable` "Screen not available: <reason>" over the picture, while Disconnect stays.

**Tests**

- Unit: `x11_follow` `follow_loginctl_*` (user desktop and locked, greeter, Wayland greeter and desktop, tty, closing, no display, other types, garbage output, defensive parsing) and `follow_screen_file_*`; `session::following` `follow_*` with a fake watch (user to greeter and back with a keyframe from each screen and input on the new one only, held buttons released before a switch, lock and unlock as state only, Wayland and text console waiting open, no seat at the start, a screen that will not open retried, capture failure looking again instead of ending, watch-only never building an injector); `notice_keep_on_moves_the_bar_to_another_screen`; agent `a_following_session_with_nothing_to_show_stays_open_with_the_reason`; `control_agent_messages_serialise_as_the_spec_says`.
- Headless switch: `follow_switch_between_two_x_servers_keeps_the_stream_and_moves_input_and_bar` starts two Xvfb servers with their own cookies (`NestedX::start_two`), drives the seat through a test `ScreenWatch` from A (a desktop) to B (the sign-in screen), and checks the `sign-in` state, the keyframe's colour from B, the pointer moving on B and not on A, and the notice bar leaving A for B.
- Browser: `screen.test.ts`; `desktop.svelte.test.ts` "shows what the machine screen shows and stays open while it changes".
- End to end (scratch server on port 47740, the debug agent with `BMUSTER_DESKTOP_SCREEN_FILE`, headless Xvfb `:181` painted blue and `:182` painted red, each with its own cookie, Playwright Chromium): Connect showed the blue screen and "jack's desktop" with the notice bar on `:181`; `screen=locked` changed the line to "jack's desktop · locked"; switching the file to `:182` and `sign-in` turned the picture red with "Sign-in screen", moved the bar to `:182` (gone from `:181`), and clicks still went out; `unavailable` with "Text console" showed "Screen not available: Text console" over the picture with Disconnect still there, at 1280 and 390 px; switching back to `:181` brought the blue picture back. The session never ended.

**Jack's manual test (Linux Mint, Cinnamon, LightDM, X11)**

Install the agent built from this branch, then from the console, on another device:

1. Open the laptop's Desktop tab and press Connect. The picture shows the desktop; the status line says "jack's desktop"; the notice bar is at the top of the laptop's screen.
2. At the laptop, lock the screen (Super+L). The status line says "jack's desktop · locked" and the picture shows the lock screen. Unlock remotely by typing the password into the picture: it goes back to "jack's desktop".
3. Sign out from the laptop's menu while connected. Within a few seconds the picture shows the LightDM sign-in screen, the status line says "Sign-in screen", the session is not ended, and the notice bar is on the sign-in screen.
4. Sign in remotely: click the user, type the password, press Enter. The picture follows into the desktop, and the status line says "jack's desktop" again.
5. Switch user (menu, Switch User): the sign-in screen for a new seat session appears in the picture ("Sign-in screen"). Choose Jack again and sign in: the picture comes back to the desktop.
6. Optional: press Ctrl+Alt+F3 at the laptop. The tab says "Screen not available: Text console" and stays connected; Ctrl+Alt+F7 brings the picture back.
7. Press Disconnect in the console: the bar goes away at the laptop.

Report anything that ends the session instead of following, and `journalctl -u bmuster-agent` lines starting "The screen at the machine" or "Desktop capture failed".

**Not tested here:** a real LightDM, GDM or SDDM greeter and its Xauthority (unit-tested paths only), a real lock screen's `LockedHint`, Wayland machines beyond the reason text.

## 17. As built: the Windows desktop helper (2026-11-08)

The Desktop tab works on Windows like VNC in service mode: the sign-in screen, the lock screen, UAC prompts and the user's desktop, following console session changes without ending the browser session. Real testing before this (Windows 11 build 26200) showed "The machine stopped sending its screen" and "Nobody is signed in": the service in session 0 cannot capture the console. **Built and compile-checked only; not yet run on Windows.**

**Design**

- **Who runs what.** The agent's worker (`run --launched`, a child of the LocalSystem service, in session 0) no longer opens desktop sessions itself. `sessions/mod.rs` sends a Windows desktop ticket to `sessions/windows_desktop/supervisor.rs` before any socket is opened. One helper process per console session carries every desktop session there, so the notice bar lists every viewer and the four-session limit holds.
- **Starting the helper** (`bmuster-desktop` `winsession/launch.rs`): the SYSTEM token of `winlogon.exe` in the target session (process snapshot, `ProcessIdToSessionId`), `DuplicateTokenEx` to a primary token, `SetTokenInformation(TokenSessionId)`, then `CreateProcessAsUserW` on `winsta0\default`, started suspended, put in a Job Object with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` (held by the worker, so a crashed agent takes its helpers down), then resumed. Command line: `bmuster-agent desktop-helper --pipe <name> --service-pid <pid> --data-dir <dir> [--insecure-dev-tls]`; nothing secret is on it. The helper logs to `desktop-helper.log` in the data folder.
- **Pipes** (`winsession/pipe.rs`, `winsession/handoff.rs`): two one-way named pipes, `<name>-in` and `<name>-out`, because Windows serialises synchronous I/O on one handle (a waiting read would hold up every write). Each allows SYSTEM only (`D:P(A;;GA;;;SY)`), refuses remote clients, has one instance and is created with `FILE_FLAG_FIRST_PIPE_INSTANCE`. The name is random; the service checks the client's process id is the helper it started, the helper checks the server's is the `--service-pid` it was given, and the helper opens the pipes at identification level. Frames: 4-byte little-endian length, then JSON, 64 KB at most. Service to helper: `start {sessionId, ticket, signature, admittedAtMs, clockOffsetMs, resume}`, `stop {sessionId}`, `quit`. Helper to service: `hello`, `attached`, `ended`, `failed`, `secure-attention`. Video never crosses the pipe.
- **Ticket hand-over.** The helper checks the ticket again with the server key from `identity.json`: signature, machine, the permission, `deny_unknown_fields`, purpose `desktop`, the session id it was started for, and the time window as of `admittedAtMs` (when the service admitted it). That last point is deliberate: a session handed to a new helper ten minutes later must still check out, and the server only accepts a session socket for a live session of this machine anyway. Replays stay the service's to refuse.
- **Streaming: the helper's own socket.** The helper opens `/agent/v1/sessions/<id>` itself, signed with the agent key, which it can read as SYSTEM (the data folder allows SYSTEM and Administrators). It signs on the service's corrected clock (`clockOffsetMs`), because the server refuses a request whose time does not beat the machine's last one and both processes sign. A signed upgrade that loses that race is retried twice, 300 ms apart.
- **Following the screen.** On Windows `open_console()` returns `Console::Following(InputDesktopWatch)` (`capture/windows_follow.rs`), the model from section 16. `look()` moves the calling thread to the input desktop (`OpenInputDesktop`, `SetThreadDesktop`; after TigerVNC as RustDesk carries it) and keys the look by the desktop's name. States: Default is `desktop {user}`; Winlogon with nobody signed in is `sign-in`; Winlogon with a user and `consent.exe` running in the session is a UAC prompt over that user's desktop, so `desktop {user}`; otherwise `locked {user}`. The user comes from `WTSQuerySessionInformationW` (`jack`, or `CORP\jack` for a domain account). The capturer moves its own thread to the input desktop on every poll (the session captures on another thread than the one that looked) and fails its poll as soon as the input desktop is another one, so the session looks again at once instead of up to a second later. DXGI is tried first on every new desktop; GDI takes over where it fails (often on Winlogon). The helper is per-monitor DPI aware, so display rectangles, the cursor and `SendInput` use real pixels.
- **Console session changes** (`winsession/follow.rs`, the supervisor). The service polls `WTSGetActiveConsoleSessionId` every 500 ms rather than taking `SERVICE_CONTROL_SESSIONCHANGE`, because the service control handler lives in the launcher process and the sessions in the worker. Start a helper for the first session; on a new console session start a helper there and send it every open session with `resume: true`; when the new helper holds every session, tell the old one to quit (it is ended 20 s after the move whatever happens); restart a helper that died, at most three times a minute, then end its sessions with a reason; stop the helper when the last session ends. Mid-switch (`0xFFFFFFFF`) nothing changes.
- **Relay hand-over (server).** For desktop sessions the relay now lets the machine's newer agent socket take over: the old one is closed with 4001 and its messages are ignored, and the browser hears `ready` again, so the page sends `hello` and gets `displays`, `state` and a keyframe from the new helper. A desktop agent socket that drops without `ended` gets 15 s (`agentHandoverMs`) for a new one before the session ends as `agent-lost` (signing out kills the old helper before the new one connects). Terminal, command and files sessions still refuse a second socket and end at once. This also delays a real `agent-lost` on Linux desktops by 15 s.
- **Notice bar** (`notice/windows.rs`): a topmost tool window at the top centre of the primary display, "<names> is connected (BMuster)" and a Disconnect button, on its own thread, excluded from the capture with `SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE)` (Windows 10 2004 and later; older builds show it in the stream and log a warning). It lives on the Default desktop and its thread never moves, so it is **not shown on the sign-in screen, the lock screen or a UAC prompt**: a window there would need the capture thread's desktop, and `SetThreadDesktop` fails for a thread that owns a window. Disconnect ends every desktop session with `disconnected-at-machine`, audited as on X11.
- **Ctrl+Alt+Del.** The full-screen bar's Ctrl+Alt+Del (Windows machines, control sessions) and the phone key bar's send `special ctrl-alt-del`. In the helper the Windows injector calls a hook that sends `secure-attention` over the pipe (only from the current helper; the session's own filter already drops it for watch-only tickets). The service makes sure `HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System\SoftwareSASGeneration` allows services (1, or 3 when it was 2), then calls `SendSAS(FALSE)` from `sas.dll`, loaded at run time. The installer sets the value and records what was there in `sas-policy.json` in the data folder; the first Ctrl+Alt+Del does the same on an agent installed before this (updates do not reinstall). Uninstall restores the recorded value, or removes it if there was none, unless someone changed it since.
- **Signed-in user.** Check-ins carry the console session's user on Windows, so Overview shows "Signed in" and "Last user" as on Linux (a locked session still counts).
- **Terminals** start in `%SystemDrive%\` (`C:\`) instead of `C:\WINDOWS\system32\config\systemprofile`.
- **Send message** (Overview, System panel). Admins, and members with `desktop-control` or `terminal`: a box popping up interrupts the person as much as taking control does, so `desktop-view` is not enough. `POST /api/machines/[id]/message` (1 to 500 characters) checks access, sends `user-message {from, text}` on the live socket and audits `machine-message-sent` with the text (Activity: "Sent a message to the screen"). The agent shows it with `WTSSendMessageW` on the console session ("Message from <name> (BMuster)", no wait), which works on Home editions where `msg.exe` is missing. 409 for an offline machine. **Windows only for now:** Linux would need `notify-send` in the seat0 user's own session bus through the session-unit machinery; the button is not shown on Linux and the agent logs and drops the message there.

**Tests**

- Rust, on Linux: `winsession::handoff` (round trip, frame layout, oversized, truncated, unknown fields), `winsession::follow` `session_change_*` (start only for open sessions, move to a new console session, wait mid-switch, restart a dead helper, stop an idle one, restart budget), `winsession::sas_policy` `sas_policy_*`, `winsession::names` (console user label; sign-in, locked, UAC, desktop), `winsession::command_line` (quoting for Windows), agent `start_folder_tests`, protocol `a_user_message_reads_from_the_server`, the session test that a layout change sends `displays`.
- Rust, Windows code under Wine (`x86_64-pc-windows-gnu`, linked with zig): `pipe_pair_carries_handoff_messages_both_ways` and `pipe_accept_gives_up_when_the_helper_is_gone` over real named pipes (with an owner-only DACL, since the test is not SYSTEM), and `notice_bar_on_windows_opens_renames_and_closes`. The rest of the Windows code (launch, input desktop, SendSAS, WTS, DXGI and GDI on Winlogon, the supervisor and the helper) is clippy-checked for `x86_64-pc-windows-gnu` only.
- Server: `relay.test.ts` "desktop agent hand-over" (a newer socket takes over and the browser greets it; a lost socket gets 15 s; another machine cannot take over), `user-message.test.ts` (sent and audited; members need control or a terminal; Windows only; offline), `user-message.test.ts` in the domain. Browser: `desktop.svelte.test.ts` "R13: full screen on a Windows machine sends Ctrl+Alt+Del", `send-message.svelte.test.ts`.

**Jack's manual test (a friend's Windows 11 PC or a Windows 11 VM)**

Install the agent built from this branch with the usual install command (as Administrator). Have a second device for the console. Keep `C:\ProgramData\BMuster\agent.log` and `desktop-helper.log` for the report.

1. **Before connecting.** Overview shows "Signed in: <user>" and "Last user: <user>, …". `reg query HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System /v SoftwareSASGeneration` shows `0x1` (or `0x3`), and `sas-policy.json` is in the data folder.
2. **User's desktop.** Desktop tab, Connect. The picture shows the desktop; the status line says "<user>'s desktop". The notice bar "<your name> is connected (BMuster) · Disconnect" is at the top of the PC's screen and **not** in the picture. Move the mouse, open Start, type into Notepad. Task Manager shows `bmuster-agent.exe` as SYSTEM in the user's session (Details tab, Session ID column).
3. **UAC prompt.** Remotely, right-click Notepad, Run as administrator. The picture shows the dimmed UAC prompt (the status line stays "<user>'s desktop"); click Yes remotely. The notice bar is absent while the prompt is up and comes back after.
4. **Lock.** Press Win+L at the PC (or send it from the key bar). The picture shows the lock screen and the status line says "<user>'s desktop · locked". Click, type the PIN or password remotely, Enter: back to the desktop.
5. **Ctrl+Alt+Del.** In full screen, use Ctrl+Alt+Del on the bar: the Windows security screen appears in the picture. Choose Cancel remotely.
6. **Sign out and sign in.** Sign out from Start while connected. Within a few seconds the picture shows the sign-in screen, the status line says "Sign-in screen", and the session stays open (a short freeze while the helper moves is expected). Sign in remotely. The picture follows to the desktop.
7. **Switch user** (needs a second account): Start, the user picture, the other account. The picture shows the sign-in screen for that account; sign in or switch back. The session stays open throughout; `agent.log` shows "Starting the desktop helper in console session N" for each move.
8. **Message.** Overview, Send message, "Test from BMuster". A box "Message from <your name> (BMuster)" appears on the PC's screen; Activity shows "Sent a message to the screen".
9. **Disconnect at the PC.** Press Disconnect on the notice bar. The console says someone at the machine pressed Disconnect; Activity shows "Disconnected at the machine". Within a few seconds `bmuster-agent.exe desktop-helper` is gone from Task Manager.
10. **Terminal.** Open the Terminal tab: PowerShell starts in `C:\`.
11. **Uninstall** (optional, at the end): `SoftwareSASGeneration` goes back to what it was (gone, if it was not there before).

Report the step and the last lines of both logs for anything that ends the session, shows a black picture, or does nothing.

**Risks and not tested here:** none of this has run on Windows yet. In particular: whether `SendSAS` accepts a call from the worker (a SYSTEM child of the service, not the process registered with the service manager; if not, the call has to move into the launcher's service process), DXGI on the Winlogon desktop (GDI is the fallback), the GDI picture of the UAC secure desktop, `CreateProcessAsUserW` without explicitly enabled privileges (as RustDesk does it), the input-desktop switch timing, the pipe ACL under a real SYSTEM token, and RDP-attached or multi-monitor consoles.

## Picture quality, version 2 (IMPLEMENTED (v0.4.17))

Approved 2026-11-11. Jack: "even high quality feels a bit grainy ... maybe have an extra high that gets you close to native".

- **Cause.** Every JPEG tile kept colour at half size each way (4:2:0), which smears coloured text, icons and thin lines whatever the quality number, so Low, Medium and High looked much alike.
- **Full colour detail** (4:4:4) from JPEG quality 85 up: High, Extra high and Auto's top step. Below 85, colour stays 4:2:0 to save bandwidth.
- **High** is JPEG 90 (was 85). **Extra high** (`extra-high`) is new: JPEG 95 with full colour, close to native for text and UI, at about 2.5–3 times High's old bandwidth.
- **Older agents** refuse a quality they do not know, so the console offers Extra high only to agents 0.4.17 and later.

| #      | Criterion                                          | Test                                                                |
| :----- | :------------------------------------------------- | :------------------------------------------------------------------ |
| R10.v2 | Quality 85 and up encodes 4:4:4; below, 4:2:0.     | Rust `encode::tiles::tests::high_qualities_keep_full_colour_detail` |
| R10.v2 | Extra high is offered only to agents that know it. | `messages.test.ts` "R10"                                            |

**Scale below 100% on a still screen (fixed for 0.4.17).** A new scale starts a new stream with a fresh scaled frame, but the frame was only drawn from the screen when the capture reported a change. A still KMS screen reports none, so 75%, 50% and 25% showed black on Fedora until something changed. A new stream now always draws the scaled frame in full. Test: `session_scale_change_on_a_still_screen_sends_the_screen_not_black`.

## 18. Notice, version 2: a bar that folds, and the tray (2026-11-11)

**Status:** `IMPLEMENTED (v0.4.17)` · security and transparency work (what the person at the machine sees while someone controls it) · version bump and changelog left for the release step.

### 18.1 Problem

- The full bar ("Kim is connected (BMuster) · Disconnect") sits over the top centre of the screen for the whole session and covers whatever is there. Jack asked for something closer to TeamViewer: small and subtle, never in the way of a click, but always telling the person someone is connected.
- On a Wayland desktop captured below the display server (KMS, `Target::Console`, for example Fedora GNOME) there was no notice at all: the root agent cannot draw on a Wayland desktop, and the planned Wayland notification was never built.

### 18.2 Acceptance criteria

| #   | Criterion                                                                                                                                                                                                                                                                                                | Test                                                                                                                                                                                                                                                                        |
| :-- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| N1  | The bar comes up full size, then after 6 s folds to a pill (a red marker and "BMuster · 1 connected") at the same top-centre edge, flush with it and smaller than the bar.                                                                                                                               | desktop `notice_fold_opens_full_then_folds_after_six_seconds`, `notice_pill_text_counts_viewers`, X11 `notice_bar_folds_to_a_pill_and_opens_on_hover`                                                                                                                       |
| N2  | A new viewer opens the bar full size again for 6 s (a second session for the same person counts); a viewer leaving does not.                                                                                                                                                                             | desktop `notice_fold_opens_again_when_a_viewer_joins_but_not_when_one_leaves`                                                                                                                                                                                               |
| N3  | The pointer over the pill opens the full bar with Disconnect; it stays open while the pointer is over it and folds 3 s after the pointer leaves. A longer opening is never cut short by the linger.                                                                                                      | desktop `notice_fold_opens_on_hover_and_folds_three_seconds_after_the_pointer_leaves`, `notice_fold_a_short_linger_never_cuts_a_longer_opening`, X11 `notice_bar_folds_to_a_pill_and_opens_on_hover`                                                                        |
| N4  | A press on the pill only opens it (touch screens have no hover); Disconnect is never pressed on a folded bar.                                                                                                                                                                                            | desktop `notice_fold_opens_when_the_pill_is_pressed`                                                                                                                                                                                                                        |
| N5  | Unchanged from R11: the bar (full or folded) stays while any session with the notice is open; Disconnect ends every desktop session with `disconnected-at-machine`, audited; on Windows the bar stays out of the capture.                                                                                | desktop `notice_disconnect_ends_every_viewer_and_dropping_takes_names_off`, X11 `notice_bar_disconnect_through_xtest_ends_the_session`, Windows (Wine) `notice_bar_on_windows_opens_renames_and_closes`                                                                     |
| N6  | The agent publishes the names of the viewers whose ticket has `notice` on in `viewers.json` beside `status.json` (root-owned folder on Linux; only SYSTEM and Administrators write it on Windows): at once when they change, every 5 s otherwise. The tray refuses a stale, oversized or malformed list. | agent `tray_viewers_are_listed_while_their_session_runs`, `tray_viewer_names_are_cleaned`, `tray_viewers_file_round_trips_and_refuses_stale_or_malformed_lists`, `tray_viewers_are_published_at_once_when_they_change`, `tray_viewers_reader_rejects_an_unprotected_folder` |
| N7  | While anyone is connected, the tray says so on Linux and Windows: title and tooltip "Kim is connected (BMuster)", and a "connected" icon (Linux: the mark with a red dot and StatusNotifierItem status `NeedsAttention`; Windows: the warning icon). It goes back when the last one leaves.              | agent `tray_title_names_the_viewers_while_connected`, `tray_connected_icon_adds_a_red_dot_and_keeps_the_rest`                                                                                                                                                               |
| N8  | Linux: a desktop notification "Kim is connected to this screen (BMuster)" appears once per viewer who joins (also for viewers already connected when the tray starts), with a Disconnect action when the notification server offers actions.                                                             | agent `tray_notification_announces_each_viewer_once`                                                                                                                                                                                                                        |
| N9  | Linux: the tray menu offers "Disconnect Kim" (or "Disconnect everyone"), and the notification's Disconnect does the same: every desktop session ends through the notice board's existing path, `disconnected-at-machine`.                                                                                | agent `tray_disconnect_item_names_one_viewer_or_everyone`, `tray_disconnect_ends_desktop_sessions_through_the_notice_board`                                                                                                                                                 |
| N10 | Only the person at the screen can disconnect from the tray: the user of the active, local, graphical session on `seat0`. Anyone else, and any request but `disconnect`, is refused and nothing ends. The tray only talks to a socket in a root-owned folder.                                             | agent `tray_disconnect_is_for_the_person_at_the_screen_only`, `tray_disconnect_refuses_a_caller_not_at_the_screen`, `tray_disconnect_ignores_anything_but_its_one_request`, `tray_disconnect_request_needs_a_root_owned_folder`                                             |

### 18.3 Security notes

- **Nothing is weakened.** The notice never goes away while a session with `notice` on is open: folded, it still says BMuster and how many are connected, and every new viewer opens it full size with names. Disconnect is one hover (or one press) away, and a press on the pill cannot disconnect, so nobody ends a session from a bar they could not read. The Windows bar keeps `WDA_EXCLUDEFROMCAPTURE`. The audit is unchanged.
- **The admin's setting holds everywhere.** Only tickets with `notice: true` are listed for the tray, so a session with _Show a notice while connected_ off shows nothing in the tray either.
- **Who may press the tray's Disconnect.** The tray runs as the signed-in person, unprivileged. The agent listens on `/run/bmuster/disconnect.sock` (mode 0666 in the root-owned, mode 0755 runtime folder) and reads the caller's uid from the kernel (`SO_PEERCRED`). It answers only the uid of the active, local (`REMOTE` not 1), graphical, `user`-class session on `seat0`, read from logind's records at each connection. That is the person looking at the screen, who can press the bar's Disconnect anyway; a process running as them could equally click the X11 bar with XTest. Other local accounts (SSH users, a person switched away with fast user switching, another seat, a greeter account) get `refused` before the agent reads a byte. The only request is `disconnect`; it ends sessions (the safe direction) and nothing else, so the socket gives nobody new power. Connections are answered one at a time with 2 s timeouts; only the person at the screen can hold one open past the uid check.
- **The tray cannot be fooled into talking to someone else.** It uses the socket only when the folder is root's and not writable by others, and the socket itself is root's.
- **The viewer list is public on the machine, like `status.json`.** Any local account can read `viewers.json`: display names only (no ids, emails or session ids), the same names the bar shows on the screen. Names are cleaned (no control characters, at most 64 characters, at most 8 names). A file older than 20 s counts as nobody connected, so a stopped agent never leaves the tray saying "connected", and only root (SYSTEM or Administrators on Windows) can write one.
- **Compatibility.** `status.json` is unchanged, so a tray helper started before the update keeps working; it shows the connected state after the person signs in again (running helpers are not restarted on update).

### 18.4 As built

- **Folding** (`agent/crates/desktop/src/notice/state.rs`): `Fold` is the whole state machine, platform-free, with the clock passed in (`OPEN_FOR` 6 s, `LINGER` 3 s). The platform bars only draw the two sizes.
  - X11 (`notice/x11.rs`): the override-redirect window resizes between the two layouts, centred at y = 0. Hover comes from `EnterNotify` and `LeaveNotify` (the bar has no child windows). The pill is a red square marker and "BMuster · 1 connected" in the `fixed` font, 4 px taller than a text line.
  - Windows (`notice/windows.rs`): the topmost tool window resizes the same way; the Disconnect child button is hidden while folded, so a press lands on the bar (`WM_LBUTTONDOWN` opens it). The pointer is read on each 200 ms timer tick (`GetCursorPos` against `GetWindowRect`) rather than with `TrackMouseEvent`, because moving onto the child button would send the bar `WM_MOUSELEAVE` and fold it under the pointer.
- **Viewers for the tray** (`agent/crates/agent/src/tray/viewers.rs`): the session thread in the worker holds a `Viewer` for each desktop ticket with `notice` on, on Linux and Windows alike (on Windows the session runs in the desktop helper, but the worker's thread waits for it). The status publisher (`tray/status.rs`) now ticks every second, writes `status.json` every 5 s as before, and writes `viewers.json` at once on a change (`Cadence`). Both are written whole (a new file, then a rename or `MoveFileExW`).
- **Linux tray** (`tray/linux.rs`, `tray/connected.rs`, `tray/notify.rs`): reads both files every second. While someone is connected: no icon name (so every panel draws the pixels), the mark with a red dot drawn in at run time (no new asset), status `NeedsAttention` with the same attention pixmap, title and tooltip from `bar_text`, and the menu starts with the names, the Disconnect item and a separator. Notifications go to `org.freedesktop.Notifications` on the person's session bus from a thread of their own (zbus on a current-thread tokio runtime); the Disconnect action is added when `GetCapabilities` lists `actions`, and `ActionInvoked` for BMuster's own notification ids runs the same Disconnect.
- **Disconnect from the tray** (`tray/disconnect.rs`): started next to the status publisher. The agent speaks first, `ready` or `refused`; after `ready` the tray sends `disconnect` and gets `ended <n>`. The agent side calls `bmuster_desktop::notice::disconnect_all`, the bar's own function, so the reason and the audit are the bar's.
- **Windows tray** (`tray/windows.rs`): the icon is `IDI_WARNING` while someone is connected (`IDI_INFORMATION` otherwise), the tooltip is the bar's text, the menu has a greyed line with the names, and it refreshes every second. It has no Disconnect: the bar, with its button, is on the same screen.
- **Not built:** a tray Disconnect on Windows (the bar has it); a notification on Windows (the bar opens full size for every new viewer instead); a notice while the Windows screen shows the sign-in or lock screen (unchanged, section 17).

### 18.5 Tested here, and still to try

- Rust on Linux: the unit tests above, and the X11 tests on a nested Xephyr server (`BMUSTER_X_TESTS=xephyr cargo test -p bmuster-desktop --test x11`), including the new fold-and-hover test with XTest pointer moves.
- Windows code (`notice/windows.rs`, `tray/windows.rs`, the shared publisher): `cargo clippy --workspace --all-targets --target x86_64-pc-windows-gnu -- -D warnings` with zig as the C compiler. Not run on Windows or under Wine.
- The D-Bus notification has not been shown on a real desktop from a test; step 1 below covers it.
- **Jack's manual test (Fedora GNOME laptop, Wayland, KMS capture).** GNOME shows tray icons only with the AppIndicator extension (`gnome-shell-extension-appindicator` on Fedora); the notification works without it. Sign out and in after installing, so the new tray helper starts.
  1. Connect to the Desktop tab from another device. Within about 2 s a notification "<your name> is connected to this screen (BMuster)" appears with a Disconnect button, and the BMuster tray icon gets a red dot; its menu starts with "<your name> is connected (BMuster)" and "Disconnect <your name>".
  2. Open a second session from another browser: one more notification, for the second viewer only; the menu says "Disconnect everyone".
  3. Press Disconnect in the notification (or the menu): both sessions end; the console says someone at the machine disconnected; Activity shows "Disconnected at the machine". The red dot goes within a second or two.
  4. From an SSH session as another account, `nc -U /run/bmuster/disconnect.sock` prints `refused` and nothing ends.
  5. On an X11 or Windows machine: the bar opens full, folds to the pill after about 6 s, opens when the pointer is over it, folds 3 s after the pointer leaves, and opens full again when another viewer connects. On Windows the pill is not in the picture.

## 19. Windows cursors that invert: the text I-beam (2026-11-12)

**Status:** `APPROVED`, asked for 2026-11-12 after a real test of 0.4.19 on Windows 10.

### 19.1 Problem

The remote cursor disappears over Notepad's text area. Windows' text I-beam is a monochrome cursor whose pixels invert what is under them (AND 1, XOR 1). The agent renders each cursor over black and over white and takes alpha as `1 − (white − black)`; an inverting pixel is white over black and black over white, so it came out opaque white, which vanishes on a white page. The browser draws the cursor as an image and cannot invert the video under it.

### 19.2 Behaviour

1. A pixel is **inverting** when its render over black is at least 128 levels brighter (the mean of its three channels) than its render over white. Ordinary pixels are never brighter over black.
2. Inverting pixels are drawn opaque black.
3. Every fully transparent pixel that touches an inverting pixel (in any of the eight directions) is drawn opaque white: a one-pixel outline around the inverting shape, so it shows on light and on dark. Cursors without inverting pixels (the arrow, colour and alpha cursors) are unchanged and get no outline.
4. The classification is a pure function (`bmuster_desktop::capture::cursor_pixels`), used by `capture/windows.rs`'s `cursor_rgba`.

### 19.3 Acceptance criteria

| ID  | Behaviour                                                                                                                                           | Named test                                                                             |
| :-- | :-------------------------------------------------------------------------------------------------------------------------------------------------- | :------------------------------------------------------------------------------------- |
| CU1 | A pixel is transparent, a colour with its alpha (opaque or partly), or inverting, from its renders over black and white.                            | Rust `capture::cursor_pixels::tests::cursor_pixels_are_classified`                     |
| CU2 | Inverting pixels come out opaque black, transparent pixels touching them opaque white, other pixels unchanged; no outline without inverting pixels. | Rust `capture::cursor_pixels::tests::inverting_cursors_are_black_with_a_white_outline` |

### 19.4 As built

- `agent/crates/desktop/src/capture/cursor_pixels.rs` (pure, CU1 and CU2); `capture/windows.rs` renders over black and white as before and hands both to it.
- **Only linted, not run on Windows.** Release test: in Notepad on Windows 10, the remote I-beam shows black with a white edge over the white text area, and over a dark window; the arrow looks as before.

## 20. Settings in full screen, and Auto quality version 2 (2026-11-12)

**Status:** `IMPLEMENTED (pending release)` · the agent and the console change together; a console on an older agent keeps version 1 Auto and shows plain "Auto" · version bump and changelog left for the release step.

### 20.1 Problem

1. **Picture settings in full screen seemed not to apply** (Jack, phone testing 0.4.21): "when you change quality in full screen mode during the connection the quality doesn't actually apply until you exit full screen and then into full screen mode again."
2. **Auto aimed too low.** "The vast majority of the time ... I'm putting it on extra high quality every time and that's perfectly usable, so we should try and get the best quality possible." Version 1 Auto started at JPEG 60 and topped out at 85. It lowered only when one frame blocked the window for 2 s straight, which is rare because each ack reopens the window. It showed nobody what it chose.

### 20.2 What was wrong in full screen

- **The quality message was not the problem.** The floating sheet's Picture tab calls the same `changeSettings` as the page's panel and the bar. The relay passes `settings` straight through. The agent sends every tile again at the new quality on the very next frame (tests Q1).
- **The picture's size was.** With Scale on Fit, the agent makes the picture for the viewport the browser sent in `hello`. The browser sent it only when the session attached, and once, one animation frame after entering or leaving full screen. A phone turned on its side after going full screen (or whose browser bars were still moving at that frame) kept a picture made for the upright screen: about 60% of the size it needed, stretched and soft whatever the quality. Leaving and entering full screen again measured the turned screen, so it looked as if the quality had finally applied.
- **Fix.** The page watches the screen box (`viewport-watch.ts`: a `ResizeObserver` and the window's `resize`, settled for 300 ms) and greets the agent again when the viewport really changed. `DesktopSession.viewportChanged` sends nothing for the same size.

### 20.3 Auto, version 2

The agent decides (`agent/crates/desktop/src/auto_quality.rs`, pure, the clock passed in). It sees every frame's round trip, so it needs no help from the browser.

- **Levels** are the fixed qualities: Low (JPEG 40), Medium (65), High (90), Extra high (95, full colour). Auto starts at **High**, or at **Extra high** when the browser's `autoStart` says the last session on this machine held it.
- **Judging the link, once a second.**
  - _Delay_ is the mean round trip of the frames acknowledged that second, or how long the oldest unacknowledged frame has waited, if that is longer.
  - _Base_ is the smallest round trip in the last minute: the link's own latency.
  - _Backlog_ is delay minus base: how long frames queue because they are too big for the link.
  - A **clear** second delivered frames with under 150 ms of backlog. A **strained** second had over 300 ms (a stalled stream counts). In between resets the clear run. A second with no frames (a still screen) changes nothing.
- **Up** one level after 3 clear seconds in a row, with a keyframe so a still screen sharpens too. A good link goes from High to Extra high in about 3 s.
- **Down** one level after 2 strained seconds in a row, with no keyframe: the link is short of room, so tiles take the new level as they change. Below Medium only after 5 strained seconds in a row: a really poor link.
- **Hysteresis.** Climbing back to a level the link just failed at needs 15 clear seconds, doubling with each further failure up to 60 s. A level held for a minute is trusted again. One slow second (a big keyframe) moves nothing.
- **Telling the viewer.** The agent sends `{type: 'auto-quality', level}` after every `settings` while on Auto, and whenever the level changes. Auto staying Auto keeps its level: a `settings` that changes only the scale, or a new page's greeting, starts nothing over.
- **Showing and remembering.** Picture settings (the panel, the full-screen bar and the floating sheet) show "Auto (Extra high)". Once Auto has held a level for 20 s, the browser remembers Extra high, or else High, as the next session's `autoStart`: per machine, in `localStorage` (`bmuster.desktop.autoStart.<machineId>`). Blocked storage means High.

### 20.4 Acceptance criteria

| #   | Criterion                                                                                                                                                                                                               | Test                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| :-- | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Q1  | A quality chosen in the full-screen sheet goes to the agent at once, in full screen; the agent sends every tile at it on the next frame.                                                                                | `desktop.svelte.test.ts` "Q1"; Rust `session::tests::session_quality_change_mid_stream_resends_every_tile_at_the_new_quality`                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Q2  | A new size of the screen box (a turn, a resize) sends the new viewport within about 300 ms; the same size sends nothing.                                                                                                | `desktop.svelte.test.ts` "Q2"                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Q3  | Auto climbs to Extra high on a good link within a few seconds, steps down after 2 strained seconds, goes below Medium only after 5, and climbs back with hysteresis. A still screen or one slow second changes nothing. | Rust `auto_quality::tests::auto_good_link_climbs_to_extra_high_within_a_few_seconds`, `auto_congestion_steps_down_promptly_and_not_below_medium_unless_really_poor`, `auto_recovery_climbs_back_with_hysteresis`, `auto_a_frame_stuck_in_flight_counts_as_backlog`, `auto_one_slow_second_such_as_a_big_keyframe_changes_nothing`, `auto_a_still_screen_changes_nothing`; `pacing::tests::pacing_auto_climbs_on_a_good_link_with_a_keyframe_and_tells_the_viewer`, `pacing_auto_steps_down_when_frames_back_up`, `pacing_auto_starts_where_the_viewer_says_then_staying_auto_keeps_its_level` |
| Q4  | Picture settings show the level Auto picked ("Auto (Extra high)"); a fixed quality shows plain "Auto" again.                                                                                                            | `desktop.svelte.test.ts` "Q4"                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Q5  | Auto starts where the last session on this machine held a level for 20 s (Extra high, or else High), remembered per machine in this browser; blocked storage means High.                                                | `auto-quality.test.ts` "Q5", `desktop.svelte.test.ts` "Q5", Rust `auto_remembered_start_begins_at_extra_high`, `control::tests::control_parse_fields_and_limits`                                                                                                                                                                                                                                                                                                                                                                                                                              |

### 20.5 Judging it in practice

Watch the status line (frames per second and KB/s) and Picture settings, which now say what Auto picked.

1. **Phone, full screen, turned on its side.** Connect upright, go full screen, turn the phone. Within a second the picture redraws sharp without leaving full screen. Change Quality in the sheet's Picture tab: the whole picture redraws at once.
2. **Good link** (home Wi-Fi, or 4G with a good signal). On Auto in a fresh browser, Picture settings read "Auto (High)", then "Auto (Extra high)" within about 3–5 s of anything moving on the screen. Text should look as it does on fixed Extra high. After 20 s, the next session on that machine opens at "Auto (Extra high)".
3. **Congestion.** Play a video or scroll a busy page on a weak link, or throttle the browser's network in its developer tools. Expect pointer lag over about half a second, then within 2–3 s "Auto (High)", then "Auto (Medium)" if it stays bad. It should go to Low only when the link is very poor for 5 s or more.
4. **Recovery without flapping.** Stop the congestion. Auto climbs one level after 3 clear seconds, but back to the level it just dropped from only after 15 s (then 30 s, then 60 s if it fails again). Over a minute the label should not alternate every few seconds.
5. **Signs it is wrong:** sitting at High on a link that runs fixed Extra high smoothly for minutes; dropping on a still screen; or lag over a second for more than 5 s while it says Extra high.

### 20.6 As built

- **Agent:** `auto_quality.rs` (the decision). `pacing.rs` feeds it each acknowledged round trip and the oldest frame in flight on every capture tick, asks for a keyframe on a climb, and holds the news for the session. `session/mod.rs` sends `auto-quality`. `control.rs` reads `autoStart` and writes the new message. Version 1's step table and window-blocked timers are gone.
- **Console:** `auto-quality.ts` (the sustained level and its storage), `viewport-watch.ts`, `desktop-session.svelte.ts` (`autoLevel`, `autoStart` in every `settings`, the same viewport sent once), `desktop-settings.svelte` (the label); `floating-controls.svelte` and `+page.svelte` pass `autoLevel` through.
- **Not tested here:** a real phone turning in full screen (the test resizes Chromium's frame instead), and the thresholds on real links: 150 ms and 300 ms of backlog are first values, to tune with step 3 above. A link whose every frame is big (a constant video) raises its own base, so the backlog reads low and Auto stays higher than it should; the frame rate drops instead.

## 21. Copy and paste (phase 6 clipboard, 2026-11-12)

**Status:** `APPROVED, PENDING RELEASE` (owner approved 2026-11-12) · **security work**: the clipboard can hold passwords and other secrets, and a push changes what the person at the machine pastes next · version bump and changelog left for the release step.

### 21.1 Problem

R9 promised text copy and paste in phase 6. The agent has parsed `clipboard-push` and `clipboard-pull` since phase 1 but only logged them, and the console had no way to send them. Helpdesk staff need to paste a long command, a licence key or a URL into the machine, and copy an error message back out, without typing it through the key bar.

### 21.2 Behaviour

- **Where.** A Clipboard button on the desktop bar opens a small panel under the bar, like Keys and Picture settings. On phones and tablets in full screen, the sheet has a Clipboard tab. Both show only in a control session.
- **The panel** has one text box (the standard multi-line field) and four buttons:
  - **Get from machine** sends `clipboard-pull`; the reply's text fills the box.
  - **Send to machine** sends `clipboard-push` with the box's text; "Sent to the machine's clipboard" shows when the agent confirms it.
  - **Copy** puts the box's text on this device's clipboard (`src/lib/utils/clipboard.ts`).
  - **Paste from this device** reads this device's clipboard with `navigator.clipboard.readText()` and fills the box. When the browser refuses (a policy, no permission, not HTTPS), the panel says so plainly: paste into the box with your own keys instead.
- **Ctrl+V on the picture** (desktop browsers, a convenience). When this browser has already granted clipboard reading to the console (`navigator.permissions` reports `clipboard-read` as `granted`; today only Chromium-based browsers do, after the first **Paste from this device**), Ctrl+V while the picture has the keyboard first pushes this device's clipboard text, waits for the agent's confirmation (at most 2 s), then sends Ctrl+V, so the machine pastes what the viewer copied. Without that permission, or when the read or the push fails, Ctrl+V goes to the machine as an ordinary key press and pastes whatever the machine's clipboard holds. A key press never shows a permission prompt.
- **Text only, at most 1 MiB** (1,048,576 bytes of UTF-8) each way. A longer box is refused in the browser with a field error, before anything is sent. A longer clipboard at the machine gets `error {code: 'clipboard-failed'}` ("The machine's clipboard holds more than 1 MB of text"). Anything that is not text (an image, files) reads as empty.
- **No reply within 10 s** (an agent from before this section, which drops both messages): the panel says the machine did not answer and its agent may need updating.

### 21.3 Protocol (additions to section 5)

| Direction | Message                                                | Meaning                                                                                                                                   |
| :-------- | :----------------------------------------------------- | :---------------------------------------------------------------------------------------------------------------------------------------- |
| to agent  | `clipboard-push {text}` (unchanged)                    | Put `text` on the machine's clipboard. Control only.                                                                                      |
| to agent  | `clipboard-pull` (unchanged)                           | Read the machine's clipboard. Control only.                                                                                               |
| to viewer | `clipboard {text}` (unchanged)                         | The machine's clipboard text, in reply to `clipboard-pull`.                                                                               |
| to viewer | `clipboard-sent {bytes}` (new)                         | The push is on the machine's clipboard; `bytes` is its UTF-8 length.                                                                      |
| to viewer | `error {code: 'clipboard-failed', message}` (new code) | The screen has no clipboard BMuster can reach, or the platform call failed; `message` says which, for the person to read. Never the text. |

### 21.4 Platforms

| Screen                                                                            | Copy and paste                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| :-------------------------------------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Linux X11 (desktop and X11 sign-in screen)                                        | Built. The agent's own `CLIPBOARD` selection over `x11rb` on the session's display with its Xauthority (not `arboard`, which reads `DISPLAY` from the process environment, while the root agent serves whichever display seat0 shows). Push: a hidden window owns `CLIPBOARD` and answers `TARGETS`, `UTF8_STRING`, `STRING`, `TEXT` and `text/plain;charset=utf-8` while the control session is on that screen. After the session ends the text stays only where the desktop runs a clipboard manager that takes it over (untested here). Pull: `ConvertSelection` to `UTF8_STRING` (falling back to `STRING`), including the `INCR` protocol for large text. |
| Windows (Default desktop, and Winlogon and UAC through the helper)                | Built, through `arboard` (`clipboard-win`) in the desktop helper, which runs in the console session's window station. Linted for Windows only; not yet run on Windows.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Linux through KMS and uinput (Wayland desktops, Wayland and text sign-in screens) | Not available: KMS reads the screen below the display server and uinput is a virtual keyboard, so neither reaches the desktop's clipboard. `clipboard-failed`: "Copy and paste is not available on this screen."                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Linux Wayland through the portal helper                                           | Built (section 21.9), not yet run on a real desktop. The helper asks the portal for clipboard access (`RequestClipboard`) before the session starts. Push: `SetSelection` offering `text/plain;charset=utf-8`, `UTF8_STRING` and `text/plain`, and the helper writes the text to each program that pastes it (`SelectionTransfer`, `SelectionWrite`). Pull: `SelectionRead` in `text/plain;charset=utf-8`, falling back to `text/plain`, then `UTF8_STRING`. A portal without the Clipboard interface, or one that refuses access, leaves the session without copy and paste: `clipboard-failed` with the portal's reason.                                     |

### 21.5 Acceptance criteria

| #   | Criterion                                                                                                                                                                                                                                                    | Test                                                                                                                                              |
| :-- | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------ |
| C1  | The agent drops `clipboard-push` and `clipboard-pull` on a watch-only ticket with one `not-allowed`, and never builds a clipboard for a watch session (the clipboard lives in the control session's injector).                                               | Rust `session::tests::clipboard_watch_only_is_refused_and_touches_nothing`                                                                        |
| C2  | On a control session, a push reaches the injector's clipboard and is answered `clipboard-sent` with its byte length; a pull is answered `clipboard` with the screen's text.                                                                                  | Rust `session::tests::clipboard_push_and_pull_reach_the_screen`                                                                                   |
| C3  | A screen without a clipboard, a failing platform call, or machine text over 1 MiB is answered `clipboard-failed` with the reason, and the session goes on.                                                                                                   | Rust `session::tests::clipboard_failures_are_reported_and_the_session_goes_on`, `follow_wayland_and_text_console_wait_open_with_a_reason`         |
| C4  | A push over 1 MiB is a bad message (unchanged), and the new messages serialise as section 21.3 says.                                                                                                                                                         | Rust `control::tests::clipboard_messages_serialise_and_limit`                                                                                     |
| C5  | X11: text pushed by one BMuster clipboard is read by another client on the same display: ASCII, non-ASCII and 1 MiB (big requests and `INCR`); an empty selection reads as empty.                                                                            | Rust X11 `x11_clipboard_round_trips_text_between_clients` (nested X server)                                                                       |
| C6  | The server drops `clipboard-push` and `clipboard-pull` from the browser of a watch-only desktop session before they reach the agent (check twice, section 7).                                                                                                | `relay.test.ts` "C6"                                                                                                                              |
| C7  | Audit: each confirmed transfer is one `desktop-clipboard` entry with the direction (to or from the machine), the byte count and the session id; never the text, a hash of it, or any part of it.                                                             | `relay.test.ts` "C7", `sessions.test.ts` "C7"                                                                                                     |
| C8  | The panel: Get from machine sends `clipboard-pull` and fills the box from the reply; Send to machine sends `clipboard-push` with the box's text and shows the confirmation; an agent error shows in the panel.                                               | `clipboard-panel.svelte.test.ts` "C8"                                                                                                             |
| C9  | Text over 1 MiB is refused in the panel with a field error and nothing is sent; Copy writes the box to this device's clipboard; Paste from this device fills the box, or explains when the browser refuses.                                                  | `clipboard-panel.svelte.test.ts` "C9"                                                                                                             |
| C10 | No reply within 10 s says the machine did not answer.                                                                                                                                                                                                        | `clipboard.svelte.test.ts` "C10"                                                                                                                  |
| C11 | Ctrl+V on the picture with clipboard reading granted pushes this device's text, then sends Ctrl+V; without the permission, Ctrl+V passes through untouched.                                                                                                  | `clipboard.svelte.test.ts` "C11"                                                                                                                  |
| C12 | The desktop bar has the Clipboard button and the full-screen sheet the Clipboard tab, in control sessions only.                                                                                                                                              | `desktop.svelte.test.ts` "C12", `floating-controls.svelte.test.ts` "C12"                                                                          |
| C13 | Wayland portal: the agent sends each clipboard call to the helper with its own id and takes only the answer with that id; a late answer is dropped; a call with no answer within 5 s, or after the helper has gone, fails with the reason.                   | Rust `wayland::clipboard::tests::c13_replies_route_by_id_and_end_with_the_helper`                                                                 |
| C14 | Wayland portal: a pull reads the best text type the clipboard's owner offers (`text/plain;charset=utf-8`, then `text/plain`, then `UTF8_STRING`), trying each in turn when the owner is not yet known; a selection with no text reads as empty.              | Rust `wayland::clipboard::tests::c14_pull_picks_the_best_text_type`                                                                               |
| C15 | Wayland portal: a push offers the UTF-8 text types and writes the text to a program that pastes it; a type it did not offer, a refused push, or a push another program has since replaced is refused (`SelectionWriteDone` false) and the text is forgotten. | Rust `wayland::clipboard::tests::c15_push_answers_transfers_until_another_program_takes_over`                                                     |
| C16 | Wayland portal: a pull of more than 1 MiB fails with "more than 1 MB"; exactly 1 MiB reads whole; a push over 1 MiB is refused in the helper too.                                                                                                            | Rust `wayland::clipboard::tests::c16_pull_is_capped_at_one_mebibyte`                                                                              |
| C17 | Wayland portal: a clipboard owner that never finishes writing fails the pull after 3 s with a reason, before the agent gives up; clipboard work never holds the helper's pointer and key input.                                                              | Rust `wayland::clipboard::tests::c17_pull_from_a_stuck_owner_times_out`                                                                           |
| C18 | Wayland portal: the largest push, every byte escaped, crosses the helper pipe as one packet, whole and in order with the input around it, and the largest pull fits one packet back.                                                                         | Rust `wayland::helper::tests::c18_clipboard_commands_cross_the_pipe_with_input`, `wayland::wire::tests::c18_largest_clipboard_text_fits_a_packet` |

### 21.6 Security notes

- **Control only, checked twice.** The agent drops both messages on a watch-only ticket (unchanged, section 7), and the injector that carries the clipboard is never built for a watch session. The relay now also drops them from a watch-only session's browser. Pulling needs control because it reads the person's data; pushing because it changes what they paste next. No new permission: copy and paste is part of controlling the screen, as typing is.
- **Never stored or logged.** The text passes through the relay as keystrokes do and is never written to the database, the server log, the agent log or the session timeline.
- **Audit by byte count only.** Section 9 said "length, SHA-256". The hash is dropped: a hash of a short secret (a password, a PIN) can be reversed by trying candidates, so it would put the secret in the audit log in all but name.
- **Audited from the agent's confirmation.** The relay writes `desktop-clipboard` when the agent says `clipboard-sent` or replies `clipboard`, so a push the machine refused is not recorded as a transfer, and the browser cannot forge an entry: those messages come only from the agent's own signed socket.
- **The viewer's clipboard is read only on their gesture.** Paste from this device is a button press; Ctrl+V reads only when the browser already holds the permission, so the console never shows a permission prompt unasked and never reads the viewer's clipboard in the background.
- **The person at the machine.** A push replaces their clipboard, as a paste by someone at the keyboard would; the notice bar already tells them someone is in control. On X11 the hidden owner window lives only while the control session is on that screen.
- **Wayland portal sessions.** Clipboard access is asked for in the same portal approval as the screen and input, and only for control sessions; a watch session never asks. The helper keeps a pushed text only while this session owns the desktop's clipboard and forgets it as soon as another program copies. Text crosses the helper's private socket (root agent to the signed-in user's helper), the same channel as keystrokes, and neither side logs it.

### 21.7 Open questions

1. ~~Wayland portal clipboard (section 21.4): build it now or later?~~ Closed 2026-11-12: built (section 21.9).
2. Automatic sync (R9 "later") stays out: every transfer is a button press or Ctrl+V.

### 21.8 As built (pending release)

- **Agent** (`agent/crates/desktop`): `clipboard/mod.rs` (limits and the shared reasons), `clipboard/x11.rs` (the selection owner thread and the reader, section 21.4), `clipboard/windows.rs` (`arboard`, new Windows-only dependency of the desktop crate, already in the build through the tray). `InputBackend` gained `set_clipboard` and `clipboard`, defaulting to "not available", so uinput needs no change; `XTestInput` makes its `X11Clipboard` on the first push, `SendInputBackend` calls `arboard`, and the Wayland portal input (`agent/src/wayland/capture.rs`) goes through the portal helper (section 21.9). `DesktopSession` answers `clipboard-push` with `clipboard-sent` and `clipboard-pull` with `clipboard`, or `clipboard-failed`; a following session with no screen open says "not available" rather than staying silent. The pull runs on the session thread and can hold frames for up to 3 s while a slow owner answers.
- **Server** (`relay.ts`): `start` takes an `onClipboard` callback beside `onEnded`; `sessions.ts` writes `desktop-clipboard` (direction, bytes, session) from it. A watch-only desktop's `clipboard-push` and `clipboard-pull` are dropped. New audit kind `desktop-clipboard`, "Copied text to or from a screen", with the clipboard icon on the Activity page.
- **Console**: `clipboard.svelte.ts` (`DesktopClipboard` state and `attachPasteShortcut`), `clipboard-panel.svelte`; `desktop-session.svelte.ts` routes the replies to it; the page's bar has the Clipboard button (control only) and the full-screen sheet a Clipboard tab. `src/lib/utils/clipboard.ts` gained `readText` and `readGranted`.
- **Tested here:** the Rust unit tests above; the X11 round trip on a nested Xephyr server (`BMUSTER_X_TESTS=xephyr cargo test -p bmuster-desktop --test x11 x11_clipboard`), including 1 MiB, non-ASCII, `INCR` in 64 KiB and 256 KiB parts and an over-limit `INCR`; the relay, audit and browser tests; Windows code linted with `cargo clippy --target x86_64-pc-windows-gnu`.
- **Not tested:** on a real X11 desktop against GTK and Qt programs (only BMuster's own reader and a test `INCR` owner talked to the selection); on Windows at all; Ctrl+V in a real Chromium with the permission granted (the test drives the shortcut with the permission check stubbed). Release check: on an X11 desktop and on Windows, Send to machine then Ctrl+V in a text editor pastes the text; copy in the editor, Get from machine shows it; Ctrl+V on the picture after one Paste from this device pastes this device's text.

### 21.9 Wayland portal sessions (2026-11-12)

**Status:** `APPROVED, PENDING RELEASE` (owner approved 2026-11-12, closing open question 1) · **security work**: a new permission asked for in the desktop's approval, and clipboard text on the helper channel.

**Design.**

- **Asked for in the approval.** The helper calls `org.freedesktop.portal.Clipboard.RequestClipboard` on the RemoteDesktop session after `SelectDevices` and `SelectSources` and before `Start`, so the clipboard is part of the one approval. If the portal has no Clipboard interface (an old xdg-desktop-portal) or refuses the request, the session starts without copy and paste and every clipboard call is answered `clipboard-failed` with that reason. A watch session never asks.
- **Routing.** Like input, clipboard calls go from the session thread through the bridge's command queue to the helper (`wire::Command::ClipboardSet {id, text}`, `ClipboardGet {id}`), and the answers come back on the frames connection (`Event::ClipboardSet {id}`, `ClipboardText {id, text}`, `ClipboardFailed {id, message}`). Each call has its own id. The session thread waits up to 5 s for the answer with that id (the helper's own limit is 3 s, so its reason arrives first), as an X11 read holds it for up to 3 s; a late answer is dropped. JSON packets on the helper channel may now be up to 6 x 1 MiB + 4 KiB (every byte of the largest text escaped); other packets are unchanged.
- **In the helper.** Clipboard work runs beside the input loop (pending futures in the same task), so a stuck clipboard owner never holds the pointer and keys. Pipes from the portal are read and written non-blocking with the 3 s limit and the 1 MiB cap. `SelectionTransfer` and `SelectionOwnerChanged` are read straight off the bus and matched to the helper's own session path (ashpd's streams look up a session object per signal and drop the signal when that fails, which would leave a paste hanging).
- **Push.** `SetSelection` with `text/plain;charset=utf-8`, `UTF8_STRING` and `text/plain`; `clipboard-sent` follows the portal's reply. Each `SelectionTransfer` in one of those types gets `SelectionWrite`, the text, then `SelectionWriteDone(true)`; anything else gets `SelectionWriteDone(false)`. When another program takes the clipboard (`SelectionOwnerChanged`, not ours), the helper drops the text from memory.
- **Pull.** While this session owns the clipboard, its own text. Otherwise the best text type from the latest `SelectionOwnerChanged`, or each wanted type in turn when none has been seen yet. A clipboard with no text type reads as empty. The bytes are read as UTF-8, with invalid sequences replaced.
- **Refusals.** A portal `AccessDenied` or `NotAllowed` reads "The desktop did not allow copy and paste for this session. On KDE Plasma it needs 6.5.3 or later." (KDE's portal reported clipboard access as never granted before 6.5.3, KDE bug 511989.)

**Saved permissions (restore tokens).** The token file and its handling are unchanged. A token saved before this change was granted without the clipboard. The portal decides whether restoring it includes clipboard access, and BMuster cannot see the portal's `clipboard_enabled` answer through ashpd 0.12.3. So existing tokens keep working for the screen and input (no new prompt, no lost unattended access); if the desktop restores them without the clipboard, copy and paste answers with the refusal above. Deleting the saved permission (`wayland-<uid>-control.json` in the agent's data folder, as root) makes the next control session ask again at the machine, with the clipboard included. BMuster does not drop old tokens itself: that would need someone at every portal machine after the update.

**Tested here:** the Rust tests C13 to C18, with a fake portal standing in for the desktop (`agent/crates/agent/src/wayland/clipboard/tests.rs`). **Not tested:** the whole portal path on a real desktop (no KDE or GNOME Wayland machine here).

**Manual release check (Fedora KDE Plasma on Wayland, Plasma 6.5.3 or later):**

1. With no saved permission: start a control session and approve at the machine. Send to machine "Grüße, BMuster", then Ctrl+V in Kate and in Konsole: the text pastes once, accents intact (KDE bugs 512075, 512076).
2. Copy a line in Kate, Get from machine: the line shows in the panel. Copy an image in Spectacle, Get from machine: the box is empty, with no error.
3. Copy 1 MiB of text on the machine, Get from machine: it arrives whole. Copy a little over 1 MiB: "more than 1 MB".
4. Move the mouse and type while a Get from machine waits on a slow program: input still reaches the desktop.
5. End the session and start another with nobody at the machine: it starts from the saved permission without a prompt. Record whether copy and paste still works (the portal restored the clipboard) or answers the refusal.
6. With a saved permission from 0.4.21 or earlier: the session starts without a prompt; record whether copy and paste works. If not, delete the saved permission, approve again at the machine, and repeat step 1.
7. If KDE's dialog lets the person refuse the clipboard alone, refuse it: screen and input work, and copy and paste answers the refusal.
8. The agent log and the journal hold no clipboard text: `journalctl -u 'bmuster-wayland-*'` and the agent log show only reasons and byte counts.
9. GNOME (Fedora Workstation), if one is available: steps 1, 2 and 5.

## 22. The local cursor: remote control without pointer lag (pending release)

**Status:** `IMPLEMENTED (pending release)`, approved by the owner 2026-11-12.

### 22.1 Problem

The browser drew the remote cursor where the agent last reported it: one round trip behind the viewer's mouse. On a slow link the pointer trails the hand, and every click feels late even when the picture keeps up.

### 22.2 Behaviour

The pure rules are in `cursor-plan.ts`; `local-cursor.ts` draws them (the stage's CSS cursor and the cursor canvas). Positions are in stream pixels, as the agent reports them (4.2).

1. **Mouse, controlling.** While a mouse is over the picture itself, the stage's CSS `cursor` is the remote cursor's shape, so the viewer's own computer draws it at full rate, with no lag, in the remote's shape (arrow, I-beam, resize arrows). The cursor canvas draws nothing while the agent's position agrees with where we sent the pointer, and nothing while our input is less than 500 ms old.
2. **Moved at the machine.** When we have sent no pointer for 500 ms and the reported position is more than 4 stream pixels from where we last sent it (someone at the machine, or a program moving the pointer), the canvas draws the reported cursor again, beside the viewer's own.
3. **Size.** The shape is shown as the canvas would draw it: one stream pixel per image pixel, then the picture's scale and the pinch zoom. Transparent padding around the shape is trimmed first (a KMS cursor plane is 64 or 256 pixels square around a small arrow), keeping the hotspot inside. On a high-density screen the picture is made at the device pixel ratio and given through `image-set()`, with a plain `url()` for a browser that refuses it; both fall back to `auto`. A shape over 32 CSS pixels (browsers cap cursors, and Chromium drops one over 32 pixels where it crosses the browser's own frame) is not used as a CSS cursor: the CSS cursor is `none` and the canvas draws the shape where we sent the pointer.
4. **Touch.** The canvas draws the cursor where we sent the pointer, at once (trackpad and tap-to-click both send it). When the fingers have rested for 500 ms and the agent reports the cursor more than 4 stream pixels away, the canvas snaps to the reported position, and the next trackpad gesture carries on from there.
5. **Hidden.** When the agent reports the cursor hidden (a game, a full-screen video), the canvas draws nothing and a mouse over the picture gets `cursor: none`. Controls laid over the picture keep their own cursor.
6. **No cursor reports.** An agent that has sent no cursor shape since `hello` puts the cursor in the picture or has none to send; the viewer's cursor is left alone.
7. **View only.** A watch-only session never changes the CSS cursor and always draws the reported cursor.
8. **The machine.** Only the browser changes. The agent never hides, moves or replaces the machine's own cursor for this.

### 22.3 Cursors in the picture, per capture path (checked 2026-11-12)

| Path                        | Cursor in the picture?                                                                                                                                                                                                                                                                                                         |
| :-------------------------- | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Windows DXGI duplication    | No: the duplicated frame never contains the pointer; its shape comes from `GetCursorInfo`, not the frame's pointer metadata.                                                                                                                                                                                                   |
| Windows GDI (`BitBlt`)      | No: `SRCCOPY \| CAPTUREBLT` copies no cursor. `DrawIconEx` draws only into the agent's own bitmap to render the shape (section 19).                                                                                                                                                                                            |
| Linux X11 (`GetImage`, SHM) | No: the X server leaves the cursor out of images; the shape comes from XFixes.                                                                                                                                                                                                                                                 |
| Linux KMS (console capture) | No: version 2 composes every plane except the cursor plane (SPEC-CONSOLE-CAPTURE P2, `kms::compose::tests::layers_in_zpos_order`); the legacy path copies the primary framebuffer only. A compositor that draws its own cursor into the frame (no cursor plane) shows it in the picture and lights no cursor plane, so rule 6. |
| Wayland portal (PipeWire)   | **Yes:** the ScreenCast session asks for `CursorMode::Embedded`, and the capturer reports no cursor. Rule 6 leaves the viewer's own cursor alone, so this path keeps its old look (the viewer's arrow plus the picture's cursor). Metadata mode would need the PipeWire cursor metadata, which `gst-launch` does not pass on.  |

### 22.4 Acceptance criteria

| ID  | Behaviour                                                                                                                                                                    | Named test                                                                                                                         |
| :-- | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :--------------------------------------------------------------------------------------------------------------------------------- |
| LC1 | A mouse controlling wears the remote shape; no canvas cursor while moving or agreeing. CSS values: `image-set` then `url()`, then `auto`.                                    | `cursor-plan.test.ts` "LC1: a mouse controlling the machine wears the remote shape…", "LC1: builds image-set for a sharp picture…" |
| LC2 | The reported cursor is drawn again after 500 ms without our input, when more than 4 stream pixels away.                                                                      | `cursor-plan.test.ts` "LC2: the reported cursor is drawn again…"                                                                   |
| LC3 | View only: CSS cursor untouched, reported cursor drawn.                                                                                                                      | `cursor-plan.test.ts` "LC3: view only never changes the CSS cursor…"                                                               |
| LC4 | Touch: drawn at the sent position at once, snapped to the reported one once input rests; display and stream pixels map both ways.                                            | `cursor-plan.test.ts` "LC4: touch draws at the predicted position…", "LC4: map both ways…"                                         |
| LC5 | A hidden remote cursor hides the local one, except over controls laid on the picture.                                                                                        | `cursor-plan.test.ts` "LC5: a hidden remote cursor hides the local one too…"                                                       |
| LC6 | No cursor shapes from the agent: the viewer's cursor is left alone.                                                                                                          | `cursor-plan.test.ts` "LC6: an agent that sends no cursor shapes…"                                                                 |
| LC7 | Size at the picture's scale and zoom, padding trimmed, over 32 CSS pixels drawn on the canvas instead.                                                                       | `cursor-plan.test.ts` "LC7: a shape too big…", "LC7: is sized at the picture scale…", "LC7: trims the padding…"                    |
| LC8 | In the page: a mouse over the picture gets the CSS cursor from a cursor message; the canvas draws none while they agree; moved at the machine draws it; hidden gives `none`. | `local-cursor.svelte.test.ts` "LC8: a mouse wears the remote cursor as its CSS cursor…"                                            |
| LC9 | In the page, view only: the stage's CSS cursor stays unset and the canvas draws the agent's cursor.                                                                          | `local-cursor.svelte.test.ts` "LC9: view only keeps the viewer cursor…"                                                            |

### 22.5 As built

- `cursor-plan.ts` (pure: the plan, sizes, CSS values, crop, pixel mapping) and `local-cursor.ts` (shapes, reports, the stage's CSS cursor, the cursor canvas). `desktop-canvas.ts` draws tiles only and resizes the cursor canvas through `LocalCursor.resize`; `desktop-session.svelte.ts` hands cursor messages to the `LocalCursor`; `screen-input.ts` tells it every pointer it sends and asks it where the trackpad carries on from.
- No agent change: no capture path but the portal puts the cursor in the picture (22.3), and the portal cannot send it separately through the current pipeline.
- **Still to try by hand:** the feel on a real slow link; the CSS cursor size on a 4K remote with a 125% or 150% console screen; Firefox and Safari accepting `image-set()` for `cursor` (the plain `url()` covers a refusal); a KMS machine whose cursor plane is 256 pixels square (trimmed, LC7). Near the top edge of the page Chromium may show its own arrow instead of a CSS cursor over 32 pixels; such cursors are drawn on the canvas instead (rule 3).
- **Known limit:** a KMS cursor partly off the top or left edge is reported hidden (SPEC-CONSOLE-CAPTURE), so for those few pixels a mouse over the picture shows no cursor.

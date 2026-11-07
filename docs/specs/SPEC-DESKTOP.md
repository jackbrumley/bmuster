# SPEC-DESKTOP: Remote desktop sessions

**Status:** `PHASE 1 BUILT FOR LINUX X11` (2026-11-07; Windows helper, H.264 and later phases not built; version bump and changelog left for the release step, as for SPEC-SESSIONS) · approved 2026-11-07 · **Date:** 2026-11-07 · Builds on the generic session tickets and binary relay (SPEC-SESSIONS and the terminal and files plan). Design inputs: `docs/concept.md` §5, `docs/access-and-sign-in.md` §1, the remote desktop research report approved 2026-11-07.

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
| R8  | Displays: the agent lists displays; the viewer picks one; switching rebuilds capture and sends a keyframe. All-screens view in phase 4.                                                                                                                                                          | agent `displays` tests, `desktop.svelte.test.ts`                   |
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
- **Auto quality.** With quality on Auto, the agent lowers the H.264 bitrate or the JPEG quality one step when frames wait on the window for 2 s, and raises it one step after 10 s with the window never full.
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

| Type             | Fields                                                                                                                      | Needs   |
| :--------------- | :-------------------------------------------------------------------------------------------------------------------------- | :------ |
| `hello`          | `codecs: ('h264' \| 'jpeg' \| 'webp')[]`, `viewport: {width, height, pixelRatio}`                                           | view    |
| `keyframe`       | —                                                                                                                           | view    |
| `ack`            | `seq`                                                                                                                       | view    |
| `select-display` | `display` (an id from `displays`, or `all` from phase 4)                                                                    | view    |
| `settings`       | `quality: 'auto' \| 'low' \| 'medium' \| 'high'`, `scale: 'fit' \| 1 \| 0.75 \| 0.5 \| 0.25`, `maxFps: 5 \| 10 \| 15 \| 30` | view    |
| `pointer`        | `x`, `y` (display pixels, unscaled), `buttons` (bit mask: left 1, right 2, middle 4, back 8, forward 16)                    | control |
| `wheel`          | `dx`, `dy`, `mode: 'pixel' \| 'line'`                                                                                       | control |
| `key`            | `code` (`KeyboardEvent.code`), `key` (`KeyboardEvent.key`), `down: boolean`, `altGr: boolean`                               | control |
| `text`           | `text` (up to 256 characters), typed as characters                                                                          | control |
| `special`        | `name: 'ctrl-alt-del' \| 'win' \| 'alt-tab' \| 'print-screen'`                                                              | control |
| `release-all`    | —                                                                                                                           | control |
| `clipboard-push` | `text` (up to 1 MB)                                                                                                         | control |
| `clipboard-pull` | —                                                                                                                           | control |
| `disconnect`     | —                                                                                                                           | view    |

### 5.2 Agent to browser

| Type        | Fields                                                                                                                                                                     |
| :---------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `displays`  | `list: [{id, name, x, y, width, height, scale, primary}]`, `current`. Sent at start and whenever the layout changes                                                        |
| `stream`    | `display`, `codec: 'h264' \| 'jpeg' \| 'webp'`, `codecString` (H.264 only, e.g. `avc1.42E01F`), `width`, `height`, `scale`. Before each keyframe that changes any of these |
| `state`     | `desktop: 'default' \| 'winlogon' \| 'secure' \| 'greeter'`, `locked: boolean`, `signedInUser: string \| null`                                                             |
| `consent`   | `state: 'asking' \| 'allowed' \| 'declined' \| 'timed-out' \| 'not-needed'`                                                                                                |
| `wayland`   | `state: 'needs-approval' \| 'pending' \| 'approved' \| 'greeter-unsupported'`                                                                                              |
| `clipboard` | `text`, in reply to `clipboard-pull`                                                                                                                                       |
| `stalled`   | — (section 4.3)                                                                                                                                                            |
| `error`     | `code: 'not-allowed' \| 'too-many-sessions' \| 'capture-failed' \| 'encoder-failed' \| 'bad-message'`, `message`                                                           |
| `ended`     | `reason` (section 9). The agent closes the socket after it                                                                                                                 |

### 5.3 Input rules

- **Coordinates** are in the selected display's native pixels, whatever the scale, so changing scale never moves a click. The agent clamps them to the display and adds the display's origin.
- **Trackpad mode** (phones, the default there): the browser keeps a virtual pointer. One-finger drag moves it relatively; tap clicks left; two-finger tap clicks right; two-finger drag sends `wheel`; tap-and-drag holds the left button. **Touch mode:** a tap moves the pointer there and clicks. Pinch zooms the view in the browser only and sends nothing. Both modes send absolute `pointer` messages; the agent does not know which mode is in use.
- **Mouse** (desktop browsers): `pointermove` coalesced to one `pointer` per animation frame; button changes sent at once.
- **Keyboard by position** (desktop browsers, the default): the agent maps `code` to a scancode (Windows) or keycode (X11), so the remote layout decides the character. Shortcuts with Ctrl, Alt or Meta always go by position.
- **Keyboard by character** (phones, and a toggle on desktop for different layouts): printable characters go as `text`. Windows uses `KEYEVENTF_UNICODE`; X11 uses the keysym's keycode when mapped, else maps it to a spare keycode for the duration of the keystroke. Non-printing keys (Enter, Backspace, arrows, Esc, Tab, function keys) still go as `key`.
- **AltGr.** Windows browsers report AltGr as a synthetic `ControlLeft` down immediately followed by `AltRight` down. The browser holds a `ControlLeft` down for up to 10 ms; if `AltRight` follows, it drops the `ControlLeft` and sends `AltRight` with `altGr: true`. The agent presses Right Alt (scancode `E0 38`) on Windows and `ISO_Level3_Shift` on X11. In character mode, AltGr itself is never sent; the character it produces goes as `text`.
- **Release-all.** The browser sends `release-all` on `blur`, on `visibilitychange` to hidden, when the keyboard toggle closes and before a display switch. The agent tracks every key and button it pressed and releases them on `release-all`, on a display switch, on a desktop switch (Windows), and when the session ends for any reason, so no key stays stuck on the machine.
- **Special keys.** `ctrl-alt-del` uses `SendSAS` on Windows (the agent sets the `SoftwareSASGeneration` policy to allow services, and reports `error` if it cannot); on Linux it sends the key chord. The browser shows these on a menu, since the viewer's own system catches them.

## 6. Platforms

### 6.1 Linux X11 (phase 1)

- The root agent finds the active seat0 session through logind, its `DISPLAY` and its Xauthority: the user's from the session process's environment, the greeter's from Xorg's `-auth` argument.
- The desktop session runs as a thread in the agent and connects with that Xauthority. Capture: XShm `GetImage` per display rectangle, XDamage to find changed areas, on `x11rb`. Input: XTest. Clipboard: X selections through `arboard`.
- When the session switches (sign-in, sign-out, user switch), the agent reconnects to the new display and sends `displays`, `state` and a keyframe.
- Development override: `agent-dev` and tests may set `BMUSTER_DESKTOP_DISPLAY` and `BMUSTER_DESKTOP_XAUTHORITY` to point the agent at a nested X server. Release builds ignore both.

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
- The server works out the ticket: admins unattended with control; members get the permissions from their rules, `unattended` if any rule giving the requested permission says so; share links always `ask` (when someone is signed in).
- Any message before `hello`, or malformed JSON, gets `error {code: 'bad-message'}`; 20 bad messages end the session.

## 8. Notice and consent at the machine

- **Notice bar.** While a desktop session is open and the ticket's `notice` is true, the machine shows a small topmost bar: "<name> is connected (BMuster) · Disconnect". With several viewers it lists every name. Drawn by the desktop code:
  - Windows: a layered topmost window, excluded from the capture with `SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE)` (Windows 10 2004 and later). On older builds it shows in the stream.
  - X11: an override-redirect window at the top centre. X11 has no capture-exclusion API (open question 3).
  - Wayland: a desktop notification with a Disconnect action.
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
| `desktop-clipboard`               | direction (`to-machine` or `from-machine`), length, SHA-256; never the text                                                                                                              |
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
- **Session socket code shared:** `src/lib/runes/session-link.svelte.ts` now carries the ticket, socket, reattach and server control messages for both the terminal and the desktop.
- **Not built in this phase:** pinch zoom on phones, clipboard (phase 6), `special` keys other than the key bar's (Ctrl+Alt+Del says "Windows only, coming later"), display switching was wired but only tested with one display, the Windows helper and bar.

**End to end** (scratch server on port 47700, the debug agent with `BMUSTER_DESKTOP_DISPLAY=:95`, a headless Xvfb with its own cookie, `xsetroot`, `xclock` and `xedit` on it, Playwright Chromium): the canvas showed the root colour and the xedit window; a click into xedit and typing changed the screen; a watch-only tab showed View only, received frames and sent no input message; a reload came back to the same session with the picture; Disconnect on the notice bar (clicked through the control session) ended both sessions with "Someone at the machine pressed Disconnect."; the audit had the opened, ended and disconnected-at-machine entries. Measured at 1280 px (stream 961×601, fit): an idle screen with a ticking clock 1 fps and about 3 KB/s; the whole background changing 10 times a second (a fine plaid, worst case for JPEG) 9.9 fps and about 3.2 MB/s, with the desktop crate built optimised (an unoptimised debug build managed 4 fps). Screenshots at 390 and 1280 px, light and dark.

**Not tested here:** Windows (type- and clippy-checked only), the real display under GDM or LightDM (seat0 discovery, the greeter's Xauthority), a throttled network (R5's falling frame rate), several displays, and the release build's behaviour beyond the debug build with an optimised encoder.

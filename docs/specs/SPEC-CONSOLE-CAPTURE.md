# SPEC-CONSOLE-CAPTURE: The Linux screen as if sitting in front of it (KMS capture and uinput input)

**Status:** `IMPLEMENTED (v0.4.1)` 2026-11-09, native on the Fedora laptop since 0.4.5 (desktop, lock screen) · approved 2026-11-09 (Jack: "go", then "build everything") · builds on SPEC-DESKTOP (section 6) and replaces the plan in SPEC-WAYLAND-PORTAL for the screen and input.

**Version 2 (every plane on the CRTC):** `IMPLEMENTED (v0.4.10)` 2026-11-10 · approved 2026-11-10 (Jack's bug report: LocalSend shows only its frame on the Fedora 44 GNOME laptop) · see [Version 2](#version-2-every-plane-on-the-crtc-pending-release).

## Problem

BMuster must show and drive whatever is on the machine's physical screen: the sign-in screen, the lock screen, any signed-in user, or a text console. It is not a remote session into one account. The Wayland portal (v0.3.1) works only inside one signed-in session, asks the person at the machine for approval, and cannot see a greeter or lock screen.

## Model

Go below the compositor, to the kernel, which is what a person at the machine sees and touches:

- **Screen: DRM/KMS scanout.** The root agent reads which framebuffer each active CRTC is scanning out and copies it.
- **Input: uinput.** The root agent creates a virtual keyboard and an absolute pointer (like a QEMU USB tablet). Every compositor and the text console treat them as real devices on seat0.
- **What is on the screen** still comes from logind (`LogindWatch`), which labels it sign-in, locked or desktop. Capture no longer depends on it.

### Which path is used

| Screen on seat0                  | Capture                 | Input          |
| :------------------------------- | :---------------------- | :------------- |
| X11 greeter or session           | XShm + XDamage (as now) | XTest (as now) |
| Wayland greeter, lock or session | KMS                     | uinput         |
| Text console, or nothing found   | KMS                     | uinput         |

X11 stays as it is: it already covers greeters, has damage tracking and needs no GPU work. The portal path stays only until KMS passes the native test on the Wayland laptop (W9 below); then it is deleted.

## Capture

1. **Helper process.** KMS capture runs in `bmuster-agent console-helper`, started by the agent as a transient root unit with access to `/dev/dri/*` only (no network, no agent data, `MemoryDenyWriteExecute` off because GPU drivers can need it; everything else as strict as the agent's own unit). It talks to the agent over inherited private pipes using the existing helper wire format; it never sees credentials.
2. **Finding the screens.** For each `/dev/dri/card*` with connected connectors: open it, read resources, and for each active CRTC take its primary plane's framebuffer (`drmModeGetFB2`, needing `CAP_SYS_ADMIN`). Each active CRTC is one display; its mode gives the size. A laptop with the lid closed and no other screen has no display, and the session waits with "The screen is off".
3. **Copying.** Export the framebuffer's handles as dma-buf (`drmPrimeHandleToFD`).
   - `DRM_FORMAT_MOD_LINEAR` (and no modifier) with XRGB/ARGB8888: map the dma-buf, bracket reads with `DMA_BUF_IOCTL_SYNC`, copy rows into BGRX.
   - Any other modifier (tiled, compressed): import into EGL with `EGL_EXT_image_dma_buf_import_modifiers` on a GBM device for the card's render node, draw into a linear BGRX texture, read it back. `libEGL.so.1`, `libGLESv2.so.2` and `libgbm.so.1` are loaded with `dlopen` at run time, so a machine without them still runs the agent and reports a capture error.
   - 10-bit and other formats are converted to BGRX; unknown formats are reported, not guessed.
4. **Cursor.** Read the cursor plane's framebuffer and position for each CRTC and send it as the session's cursor shape and position (SPEC-DESKTOP 4.2), so the browser draws it.
5. **Rate and change.** Poll at the session's frame rate (15 fps by default). KMS gives no damage information, so the existing tile diff finds changed tiles; an unchanged frame sends nothing.
6. **Following.** A new framebuffer id, CRTC or mode (sign-in, user switch, VT switch, resolution change, monitor plugged in) refreshes the display list and sends `displays`, `state` and a keyframe, as the X11 path does.
7. **NVIDIA.** Needs `nvidia-drm.modeset=1`; without it the machine report and the session say so. Buffers that cannot be imported are reported with the driver's error.

## Input

1. The agent opens `/dev/uinput` only for a session whose ticket carries control, and creates two devices: **"BMuster keyboard"** (all `KEY_*` codes) and **"BMuster pointer"** (`ABS_X`/`ABS_Y` 0–65535, `BTN_LEFT`/`RIGHT`/`MIDDLE`, `REL_WHEEL`/`REL_HWHEEL` with hi-res variants). Watch sessions never open uinput. The devices are destroyed when the last control session ends.
2. **Keyboard by position:** the browser's `code` maps to the evdev key code; the machine's own layout decides the character, as for a USB keyboard.
3. **Keyboard by character** (phones): characters on the US layout are typed with their key and Shift. Other characters are not typed and the session reports "This character cannot be typed on this screen yet". Non-printing keys go by position.
4. **Pointer:** absolute coordinates over the bounding box of all displays. With one display this is exact. With several, displays are assumed side by side in connector order; the open question below covers matching the compositor's arrangement.
5. **Special keys:** Ctrl+Alt+Del and Ctrl+Alt+F1–F12 are sent as real key chords, so switching consoles works.
6. **Release-all** on blur, end of session and every screen switch, as now.

## Notice

- Wayland desktop: the agent tray (SPEC-AGENT-TRAY) in the signed-in session shows "<names> connected (BMuster)" with Disconnect while a session is watching or controlling. Without a tray host it sends a desktop notification with a Disconnect action through the user's session bus.
- Greeter, lock screen and text console: nothing can be drawn there. The session start and end are audited as always, and the agent logs them.

## Security

This is security work: KMS and uinput bypass every compositor privacy check by design.

- BMuster's own checks are the only gate: access rules, the signed session ticket's permissions (enforced again by the agent), and audit. No check is weakened.
- uinput exists only while a control session exists; watch never creates it.
- The capture helper has device access to `/dev/dri` only and no network; frames leave only through the agent's existing signed session stream.
- Nothing is captured or injected without a BMuster session; there is no background recording.

## Acceptance criteria

| #   | Criterion                                                                                                                   | Named test                                                         |
| :-- | :-------------------------------------------------------------------------------------------------------------------------- | :----------------------------------------------------------------- |
| C1  | Path choice: X11 keeps XShm/XTest; Wayland greeter, lock, desktop and text console choose KMS and uinput.                   | Rust `follow::tests::console_path_for_each_screen`                 |
| C2  | CRTC discovery from fixture resources: active CRTCs become displays; lid closed gives "The screen is off".                  | Rust `kms::tests::displays_from_resources`                         |
| C3  | Linear XRGB/ARGB/10-bit buffers convert to BGRX with stride checks; unknown formats are refused.                            | Rust `kms::tests::linear_conversion_and_refusals`                  |
| C4  | Tiled buffers go through the EGL path; missing libraries give a capture error without stopping the agent.                   | Rust `kms::egl::tests::missing_libraries_reported`                 |
| C5  | Framebuffer, CRTC or mode changes send `displays`, `state` and a keyframe.                                                  | Rust `session::following` tests with a fake KMS source             |
| C6  | Browser `code` maps to evdev codes for every key the X11 keymap covers; US characters type with Shift; others are reported. | Rust `input::uinput::tests::keymap_and_characters`                 |
| C7  | Pointer maps to 0–65535 over the displays' bounding box; buttons and wheel; release-all.                                    | Rust `input::uinput::tests::pointer_mapping_and_release`           |
| C8  | Watch never opens `/dev/uinput`; control creates the devices and the last control session destroys them.                    | Rust `input::uinput::tests::watch_never_opens_uinput`              |
| C9  | The helper unit has `/dev/dri` only, no network and no agent data; pipe closure ends it.                                    | Rust `console_helper::tests::unit_properties`, helper cleanup test |
| C10 | uinput end to end on this X11 development machine: keys and pointer reach a test window.                                    | Rust ignored test `uinput_reaches_x11_window` (run by hand)        |
| W9  | Native test on the Wayland laptop: GDM greeter, lock screen, signed-in session, user switch, text console, resize.          | Manual report in As built; not claimed from compilation            |

## Open questions

1. Multi-monitor pointer arrangement on Wayland: read the compositor's saved layout (GNOME `monitors.xml`, KDE `kwinoutputconfig.json`), or switch to a relative pointer with warping?
2. Delete the portal helper right after W9 passes, or keep it one release as a fallback for machines where KMS import fails (some NVIDIA setups)?

## As built (2026-11-09)

Built on the development machine (Linux Mint, Cinnamon on X11, two AMD GPUs, three monitors) as user `jack`, with ACL access to `/dev/uinput` and `/dev/dri/*` and no root. **Real KMS capture of a framebuffer could not be run here:** `GETFB2` withholds buffer handles without `CAP_SYS_ADMIN`. Everything up to that point ran for real; everything after it is unit-tested with fixtures or exercised on buffers this user may allocate. W9 is open.

### Where it lives

| Part             | Where                                                                                                                                                                                                                                                                                                                                                                                        |
| :--------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Path choice (C1) | `bmuster-desktop` `follow.rs`: `screen_path(Type)` (only `x11` stays on X11) and `console_state(Class, LockedHint, Name)`. `capture/x11_follow.rs` `LogindWatch::with_console(opener)` routes every non-X11 seat0 session, and no session at all, to KMS; `LogindWatch::new()` (no opener) keeps the old reasons.                                                                            |
| Discovery (C2)   | `capture/kms/mod.rs` `displays_from_resources` (pure); `capture/kms/card.rs` the raw ioctls (`GETRESOURCES`, `GETCRTC`, `GETCONNECTOR`, `GETENCODER`, `GETPLANERESOURCES`, `GETPLANE`, `OBJ_GETPROPERTIES`, `GETPROPERTY`, `GETFB2`, `PRIME_HANDLE_TO_FD`, `GEM_CLOSE`, `DMA_BUF_IOCTL_SYNC`); `uapi.rs` the structs and request numbers, checked against values printed from the C headers. |
| Linear copy (C3) | `capture/kms/convert.rs`: XRGB/ARGB8888 (copied), XBGR/ABGR8888, the four 2101010 formats, RGB565; unknown formats are refused with their fourcc.                                                                                                                                                                                                                                            |
| Tiled copy (C4)  | `capture/kms/egl.rs` (+ `egl_api.rs`): `dlopen` of `libEGL.so.1`, `libGLESv2.so.2`, `libgbm.so.1`; GBM device on the card's render node, surfaceless GLES 2 context, dma-buf import with the modifier (up to 4 planes), drawn with a `samplerExternalOES` shader into an RGBA texture and read back.                                                                                         |
| Reader           | `capture/kms/device.rs` `KmsReader`: all cards, last frame per display (an unchanged frame answers "unchanged"), cursor plane per CRTC, NVIDIA modeset hint.                                                                                                                                                                                                                                 |
| Capturer (C5)    | `capture/kms/capturer.rs` `KmsCapturer` over any `KmsSource`; `lib.rs` `kms_platform(source, uinput opener)`.                                                                                                                                                                                                                                                                                |
| uinput (C6–C8)   | `input/uinput.rs`: the two devices, `Shared<T>` (created on first control session, destroyed with the last), `Opener`, US character table.                                                                                                                                                                                                                                                   |
| Helper (C9)      | agent `console_helper/`: wire requests and replies, `serve`, `HelperClient` (the agent's `KmsSource`), `Opener` (`ConsoleOpener`), `unit_arguments`; `probe.rs` for `kms-probe`. `wayland/wire.rs` gained a raw-pixel packet (tag 3, up to 256 MiB).                                                                                                                                         |
| Agent wiring     | `wayland::Watch` now wraps `LogindWatch::with_console(console_helper::Opener)`; the portal path runs only when KMS has failed on a signed-in Wayland desktop. `main.rs`: hidden `console-helper`, and `kms-probe --png <path>`.                                                                                                                                                              |

### Tests

| #   | Test                                                                                                                                                                                           | Status                                                                                                                                                                                                                                                                                                                   |
| :-- | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1  | `follow::tests::console_path_for_each_screen`                                                                                                                                                  | Passes. Text console with nobody signed in (no logind session) reads as `sign-in`.                                                                                                                                                                                                                                       |
| C2  | `capture::kms::tests::displays_from_resources`                                                                                                                                                 | Passes. Also run for real by `kms-probe` here (below).                                                                                                                                                                                                                                                                   |
| C3  | `capture::kms::tests::linear_conversion_and_refusals`, `convert::tests::fourcc_names_and_cursor_alpha`                                                                                         | Passes.                                                                                                                                                                                                                                                                                                                  |
| C4  | `capture::kms::egl::tests::missing_libraries_reported`; ignored `tiled_buffer_reads_back_through_egl`                                                                                          | Passes. The ignored test was **run by hand on this machine's AMD GPU**: buffers in the implicit layout and in four explicit AMD tiled modifiers (`0x0200000028a6bf04`, `…28a67f04`, `…28a37f04` — the DCC layout X11 scans out here — and `…28a01f04`) read back pixel-exact through the EGL path.                       |
| C5  | `session::following::tests::kms::follow_kms_mode_and_monitor_changes_send_displays_state_and_a_keyframe`, `capture::kms::capturer::tests::kms_capturer_keeps_its_display_and_spans_the_bounds` | Passes with a fake KMS source.                                                                                                                                                                                                                                                                                           |
| C6  | `input::uinput::tests::keymap_and_characters`                                                                                                                                                  | Passes.                                                                                                                                                                                                                                                                                                                  |
| C7  | `input::uinput::tests::pointer_mapping_and_release`                                                                                                                                            | Passes.                                                                                                                                                                                                                                                                                                                  |
| C8  | `input::uinput::tests::watch_never_opens_uinput`                                                                                                                                               | Passes: a watch session over a KMS screen never calls the opener; two control sessions share one device set; it is destroyed when the second ends and made again for a third.                                                                                                                                            |
| C9  | `console_helper::tests::unit_properties`, `helper_round_trip_and_cleanup` (round trip over a socket pair; closing the pipe ends `serve`), `a_lying_helper_is_cut_off`                          | Passes. The real `console-helper` process was also driven over its pipe here (as jack): it listed the three displays, answered capture with the `CAP_SYS_ADMIN` reason, and exited 0 when the pipe closed. Starting it as a systemd unit needs root and was **not** run.                                                 |
| C10 | ignored `input::uinput::tests::uinput_reaches_x11_window`                                                                                                                                      | **Run by hand here** with `BMUSTER_UINPUT_TEST_DISPLAY=:0`: the real devices were created on seat0, an absolute move landed on the test window within 2 px, a Shift tap reached it (the test only presses Shift, and only once the window has focus), and `/proc/bus/input/devices` showed no BMuster device afterwards. |
| W9  | Native test on the Wayland laptop                                                                                                                                                              | **Not run.** Nothing about Wayland, GDM, the lock screen, a text console or a root helper unit is claimed from this machine.                                                                                                                                                                                             |

`kms-probe` here (as jack): card1 (amdgpu) with DP-1 3440×1440@165, DP-2 1920×1080@120 and DP-3 1920×1080@60 all scanning out one 5360×2520 XR24 framebuffer with modifier `0x0200000028a37f04` (three planes, DCC), each from its own offset; card2 with every CRTC off; four cursor planes, idle; every capture refused with the `CAP_SYS_ADMIN` reason.

### Decided while building

- **A new framebuffer id is not a layout change.** Compositors flip between two or three framebuffers every frame, so only a CRTC, mode or size change refreshes the display list (read every 500 ms while capturing, and once a second by the watch). A following session now sends `state` with `displays` and the keyframe after such a change (C5).
- **DRM master is dropped on open.** The kernel makes the first opener of a card that has no master its master (a text console, or between two compositors), which would stop the next compositor from taking the screen. `Card::open` calls `DROP_MASTER` at once and only `GET*` ioctls are used after that.
- **The helper runs the root-owned copy** `/run/bmuster/bmuster-user-helper` (published by the service at start, as for the Wayland helper), never the install folder. Unit: root with `CapabilityBoundingSet=CAP_SYS_ADMIN`, `NoNewPrivileges`, `DevicePolicy=closed` with `DeviceAllow=char-drm rw` (card and render nodes), `PrivateNetwork`, `IPAddressDeny=any`, `RestrictAddressFamilies=AF_UNIX`, `InaccessiblePaths=-<data folder>`, `ProtectSystem=strict`, `ProtectHome=yes`, `PrivateTmp`, the agent unit's kernel, clock, namespace and personality protections, `MemoryDenyWriteExecute=no`, and `MESA_SHADER_CACHE_DISABLE=true`. One helper per desktop session that needs KMS, kept across screen switches, stopped when the session ends.
- **Pull, not push.** The agent asks for each frame; the helper compares it with the last one it sent for that display and answers "unchanged" (so an idle screen costs one copy and compare in the helper, nothing on the pipe). Requests time out after 3 s (10 s for the first, which opens every card); a helper that times out, ends or sends a wrong size is dropped and started again on a later look.
- **Failures wait 10 s.** A KMS failure is shown as the reason ("Screen not available: …") and retried after 10 s. On a signed-in, unlocked Wayland desktop the failure instead brings back the v0.3.1 portal approval flow, so a machine where KMS cannot work (some NVIDIA set-ups) still has a way in (open question 2).
- **uinput devices follow the screen.** A screen switch drops the session's injector (keys released first), so with one control session the devices are destroyed and made again on each switch; the compositor picks the new ones up within a moment.
- **Keyboard device codes 1–248** (`KEY_ESC` to `KEY_MICMUTE`), not "all `KEY_*`": registering the `BTN_*` range or higher would make udev class the keyboard as a mouse or joystick. Every key `keymap.rs` names is in range.
- **Characters that cannot be typed** are skipped, the rest of the text still goes, and the browser gets `error {code: 'input-failed', message: 'This character cannot be typed on this screen yet'}` (new error code, also in `src/lib/schemas/desktop/desktop.ts`). The X11 path reports its typing failures the same way now.
- **Cursor:** the cursor plane's image (premultiplied ARGB made straight) with hotspot (0, 0) at the plane's position, so the browser draws it where the screen does. `HOTSPOT_X/Y` is not read. A cursor partly off the top or left edge is hidden until it is fully on (the session only shows a cursor whose position is inside the display). A compositor drawing its own cursor into the frame shows it in the picture instead.
- **Not built:** the Wayland tray notice ("<names> connected (BMuster)" with Disconnect, or a desktop notification); the session start and end are audited and logged as before, and KMS screens get no bar (`notice::Target::Console`). The machine report does not mention NVIDIA modeset; the session does. Rotation, hardware scaling (a framebuffer source smaller or larger than the mode) and HDR are not handled; the crop is the CRTC's offset and mode size. There is no console-switch menu: Ctrl+Alt+Del (the existing special key) and Ctrl+Alt+F1–F12 typed on the viewer's keyboard go to uinput as real chords, but a Linux viewer's own system takes Ctrl+Alt+F*n* before the browser sees it.

### Known limits for W9 to check

- **Speed:** every tick copies the whole display (mapped memory for linear buffers, a GPU copy for tiled ones), compares it and sends it whole over the pipe when it changed; the tile diff then runs in the agent. Reading a linear buffer that lives in VRAM through a CPU map can be slow on discrete GPUs; the tiled path does not have that problem.
- **NVIDIA:** the proprietary driver's EGL needs `/dev/nvidia*`, which the unit's device policy does not allow; such machines get the import error (and the portal fallback on a desktop).
- **Several monitors on Wayland:** the absolute pointer spans the displays laid side by side in connector order (open question 1); with one display it is exact.

### Jack's native test (W9, the Wayland laptop)

Build from this branch on the laptop, as yourself:

```bash
cd ~/Coding/bmuster && git fetch && git switch worktree-agent-a43c3eec5131e753a
cd agent && cargo build --release -p bmuster-agent
```

1. **Probe the signed-in desktop** (no server needed; nothing is sent anywhere): `sudo ./target/release/bmuster-agent kms-probe --png /tmp/kms.png`. It prints the cards, connectors, CRTCs, every plane in use with its framebuffer's format, modifier and pitches, then writes `/tmp/kms-<display>.png` (and `/tmp/kms-<display>-cursor.png` when a cursor plane is in use). Open the PNGs: they should look like the screen.
2. **Probe the lock screen and the GDM greeter:** `sudo systemd-run --unit=bmuster-kms-probe --on-active=20 $PWD/target/release/bmuster-agent kms-probe --png /tmp/locked.png`, then lock (Super+L) within 20 s; unlock after 30 s and read `journalctl -u bmuster-kms-probe`. Repeat with `--png /tmp/greeter.png` and sign out instead of locking.
3. **Probe a text console:** Ctrl+Alt+F3, sign in, `sudo …/bmuster-agent kms-probe --png /tmp/tty.png`, then Ctrl+Alt+F1 (or F2) back.
4. **End to end:** install this build as the agent (`sudo ./target/release/bmuster-agent install --url <server> --code <join code>`, or the console's Add machine command with this binary), open the Desktop tab from another device and Connect: the signed-in desktop shows without any approval prompt and the pointer and keys work; lock (picture shows the lock screen, "· locked"), unlock by typing the password remotely; sign out (GDM greeter, "Sign-in screen") and sign in remotely; switch user and back; Ctrl+Alt+F3 typed from a Windows or macOS viewer (picture shows the text console) and Ctrl+Alt+F2 back; change the resolution (new `displays` and a keyframe, picture keeps up); press Watch only and check the agent log has no "Created the uinput devices" line for it.

Report the probe output and anything that differs, plus `journalctl -u bmuster-agent` lines with "console", "KMS", "uinput" or "The screen at the machine".

## Version 2: every plane on the CRTC (pending release)

**Status:** `IMPLEMENTED (v0.4.10)` 2026-11-10 · approved 2026-11-10 (Jack: bug report, fix approved) · security work only in that it reads more of what the kernel scans out; no check changes.

### Problem

On the Fedora 44 GNOME laptop (Wayland, mutter) the LocalSend window (Flutter on GTK) showed only its frame, and with the other windows minimised its content (about a quarter of the screen) appeared stretched over the whole picture like a wallpaper. The taskbar preview looked right. Version 1 copies only the primary plane's framebuffer (from the CRTC's offset, at the mode's size) plus the cursor plane. Mutter can put a client's buffer straight on an **overlay plane** (hardware composition), and can put a client's buffer on the **primary plane** with a source and destination rectangle that scale it. Version 1 ignored both: the overlay was missing and a scaled primary was copied unscaled.

### Behaviour

1. **Plane properties.** Every plane's atomic properties are read (the card already asks for `DRM_CLIENT_CAP_UNIVERSAL_PLANES` and `DRM_CLIENT_CAP_ATOMIC`; reading needs no master): `SRC_X/Y/W/H` (16.16 fixed point, framebuffer pixels), `CRTC_X/Y/W/H` (CRTC pixels, may hang off the edges), `zpos`, `alpha` (0–0xFFFF), `pixel blend mode` (read by its enum name: `None`, `Pre-multiplied`, `Coverage`) and `rotation` (`DRM_MODE_ROTATE_*` and `DRM_MODE_REFLECT_*`). A missing property takes the kernel's default (opaque, pre-multiplied, `rotate-0`).
2. **Layers.** The planes scanning out a CRTC, other than the cursor plane, are drawn bottom first: by `zpos`, then the primary plane below overlays, then by plane id. A driver without atomic properties keeps version 1's behaviour (the CRTC's legacy framebuffer from its offset at the mode's size); an overlay plane without them is not drawn.
3. **Composition.** Each frame is a CRTC-sized canvas, black underneath. Each layer's source rectangle is mapped onto its destination rectangle (scaled, rotated and reflected as the kernel defines them, clipped to the CRTC), then blended with its plane alpha and blend mode. The primary plane honours its own rectangles too, so a primary that does not cover the CRTC leaves black around it.
4. **Two paths, one maths.** The rectangle and rotation maths live in one pure module (`capture/kms/compose.rs`). When every layer is linear in a format the CPU reads, layers are converted on the CPU (only the source box each one touches) and blended there; a lone opaque primary that covers the CRTC one to one stays a plain copy, as in version 1. Otherwise every layer's dma-buf is imported into EGL and drawn as a textured quad onto one target, with `GL_ONE, GL_ONE_MINUS_SRC_ALPHA` blending, then read back once.
5. **Diagnostics.** Whenever the set of active planes on a captured CRTC changes (a plane appears or goes, or its geometry, format, modifier, zpos, alpha, blend or rotation changes; a new framebuffer id alone is not a change, and the cursor plane is left out of the comparison because it moves, hides and shows), the helper logs at info one line per plane, the cursor included: id, type, framebuffer id, format and modifier, `SRC_*` (16.16 fixed point shown as decimals), `CRTC_*`, zpos, alpha, blend mode and rotation. `kms-probe` prints the same line for every plane in use.
6. **Rate.** Every poll still reads the planes and compares the picture with the last one sent, as in version 1. A plane-state cache cannot skip the read: a text console (fbcon) draws straight into the framebuffer it scans out, so pixels change while every plane stays the same.

### Acceptance criteria

| #   | Criterion                                                                                                                                                     | Named test                                                                                                  |
| :-- | :------------------------------------------------------------------------------------------------------------------------------------------------------------ | :---------------------------------------------------------------------------------------------------------- |
| P1  | Plane properties become a plane: 16.16 source, signed CRTC position, size, zpos, alpha, blend by name, rotation; missing ones take the defaults.              | Rust `kms::card::tests::plane_from_properties`                                                              |
| P2  | Layer order: by zpos, primary below overlays on a tie, cursor never drawn; legacy CRTC framebuffer when there are no atomic properties.                       | Rust `kms::compose::tests::layers_in_zpos_order`                                                            |
| P3  | Rectangle maths: 16.16 source, destination scaling, clipping to the CRTC, rotation and reflection, source boxes, GPU quads, an outside source refused.        | Rust `kms::compose::tests::placement_maths`                                                                 |
| P4  | CPU composition: a primary not covering the CRTC leaves black; a scaled overlay; alpha blending for pre-multiplied, coverage and none; the lone-primary copy. | Rust `kms::compose::tests::cpu_composition`                                                                 |
| P5  | Plane-set logging: one line per plane on the first capture and on a change; not for a new framebuffer id or a moving or hiding cursor.                        | Rust `kms::compose::tests::plane_set_changes_are_logged_once`                                               |
| P6  | GPU composition: a tiled primary with a scaled, half-transparent overlay reads back as the CPU path draws it; version 1's tiled read-back still exact.        | Rust ignored `kms::egl::tests::tiled_buffer_reads_back_through_egl`, `planes_compose_through_egl` (by hand) |
| P7  | Native check on the Fedora laptop: LocalSend's window shows whole and unstretched; the log names the planes.                                                  | Manual report; not claimed from fakes                                                                       |

### As built (2026-11-10)

- **Where:** `capture/kms/compose.rs` (new: layers, `Placement` with the GPU quad, CPU blending, `PlaneWatch` and the plane line; tests in `compose_tests.rs`); `card.rs` (`plane_from_properties`, enum names through `GETPROPERTY`'s enum list, `Card::planes`; tests moved to `card_tests.rs`); `mod.rs` (`Plane` gained `src`, the full `crtc` rectangle, `zpos`, `alpha`, `blend`, `rotation`); `device.rs` (`capture` composes every layer and logs plane-set changes); `egl.rs` (`Gpu::compose` replaces `Gpu::read`: per-layer textured quads with per-vertex texture coordinates, plane alpha and blend mode uniforms, linear filtering only for scaled layers); `convert.rs` (`has_alpha`, and the 2-bit alpha of `AR30`/`AB30` is kept); agent `console_helper/probe.rs` (the plane line).
- **Tested natively here** (Linux Mint, Cinnamon on X11, AMD GPU, as jack with access to the render node): P6 by hand, with the primary in the implicit layout and in four AMD tiled modifiers, composed through the real EGL path and matching the CPU path within one level per channel. `kms-probe` read the real plane properties of this machine's three monitors (each primary's `SRC_*` equals its CRTC's legacy offset, `zpos` 2, `rotate-0`; amdgpu exposes no `alpha` or blend mode on them). **Only with fakes:** P1–P5 (fixture properties and buffers), and any overlay plane in use (X11 here never uses one). Reading framebuffers needs root, and the Wayland laptop was **not** available; P7 is open.
- **Rotation** follows the kernel's `drm_rect_rotate` (reflect, then rotate counter-clockwise); it is unit-tested against that definition only, never seen on a real rotated plane.
- **Deviation:** no re-composition cache (Behaviour 6); per frame the cost is one more `GETPLANE` and property read per plane on the CRTC and one `GETFB2` per drawn plane, and the GPU draws one quad per layer before the single read-back.
- **Added while building:** a client's framebuffer can be removed between reading the planes and exporting it (the compositor flipped away from it), so a capture reads the planes again, up to three times, before it reports the error.
- **Not handled:** YUV overlay formats (NV12, P010; video players can put them on overlay planes) on the CPU path are refused with their fourcc as before; through EGL they import if the driver supports them. Colour encoding, range, HDR metadata and the CRTC's background colour are ignored (black is assumed).

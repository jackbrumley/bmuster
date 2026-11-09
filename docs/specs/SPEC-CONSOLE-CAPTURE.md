# SPEC-CONSOLE-CAPTURE: The Linux screen as if sitting in front of it (KMS capture and uinput input)

**Status:** `APPROVED` 2026-11-09 (Jack: "go", then "build everything") · builds on SPEC-DESKTOP (section 6) and replaces the plan in SPEC-WAYLAND-PORTAL for the screen and input.

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

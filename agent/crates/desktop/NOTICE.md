# bmuster-desktop: notices

`bmuster-desktop` is part of BMuster, licensed AGPL-3.0-only, by Jack Brumley. This file lists every outside source that code was copied or adapted from, and the licences of the crates it is built with (SPEC-DESKTOP section 12).

## Code copied or adapted

| Where | From | Licence | Notes |
| :-- | :-- | :-- | :-- |
| `src/input/x11.rs`: loading the keyboard map, the keysym-to-key-code search, the character-to-keysym rule | Voquill, `src-tauri/src/platform/linux/x11/input.rs` | AGPL-3.0-only, Jack Brumley | `git blame` checked: every line used is Jack's. The three lines by Voquill's outside contributor (the macOS Command+V branch, lines 165–167) were not copied. |

## Logic followed closely, rewritten

No code was copied; these parts follow another project's logic closely enough to credit it (SPEC-DESKTOP section 12):

| Where | Follows | Licence |
| :-- | :-- | :-- |
| `src/winsession/launch.rs`: the console session's `winlogon.exe` token and `CreateProcessAsUserW` on `winsta0\default` | RustDesk, `src/platform/windows.cc` `GetLogonPid` and `LaunchProcessWin`, themselves after TigerVNC's `VNCServerService.cxx` | RustDesk AGPL-3.0; TigerVNC GPL-2.0-or-later |
| `src/winsession/input_desktop.rs`: checking and switching to the input desktop with `OpenInputDesktop` and `SetThreadDesktop` | TigerVNC `rfb_win32::inputDesktopSelected` and `selectInputDesktop`, as RustDesk's `windows.cc` carries them | GPL-2.0-or-later (TigerVNC), AGPL-3.0 (RustDesk) |
| `src/winsession/follow.rs` and the agent's `sessions/windows_desktop/supervisor.rs`: polling the active console session and moving the helper when it changes | RustDesk, `src/platform/windows.rs` `run_service` | AGPL-3.0 |

Both licences are compatible with BMuster's AGPL-3.0-only for code written after their pattern.

Nothing else was copied:

- **RustDesk:** no code was copied or vendored, and BMuster does not depend on `scrap` or `enigo`. The DXGI Desktop Duplication (`src/capture/dxgi.rs`), GDI (`src/capture/gdi.rs`) and `SendInput` (`src/input/windows.rs`) code was written from Microsoft's Win32 and DXGI documentation. The X11 capture was written fresh on x11rb.
- **MeshCentral:** no code was copied.
- **KMS capture and uinput** (`src/capture/kms/`, `src/input/uinput.rs`, SPEC-CONSOLE-CAPTURE): written from the Linux uAPI headers (`drm/drm.h`, `drm/drm_mode.h`, `drm/drm_fourcc.h`, `linux/dma-buf.h`, `linux/uinput.h`, `linux/input-event-codes.h`) and the Khronos EGL and GLES 2 headers and extension specifications. RustDesk's `drm_reader.rs`, `drm_capturer.rs` and `uinput.rs` were read for orientation only (RustDesk itself goes through libdrmtap); nothing was copied, and BMuster links neither libdrm nor libdrmtap. `libEGL`, `libGLESv2` and `libgbm` are opened with `dlopen` at run time and are not part of the agent binary.
- **The key table** (`src/input/keymap.rs`) states facts (key names, Linux evdev codes, PS/2 set-1 scancodes) from the W3C UI Events `KeyboardEvent.code` tables and `linux/input-event-codes.h`.

## Crates built into the agent

| Crate | Licence | Used for |
| :-- | :-- | :-- |
| `jpeg-encoder` 0.7.1 | (MIT OR Apache-2.0) AND IJG | JPEG tiles. Used under MIT. See the IJG notice below. |
| `x11rb`, `x11rb-protocol` 0.13.2 | MIT OR Apache-2.0 | X11 capture and XTest input (Linux) |
| `gethostname` 1.1.0 (through x11rb) | Apache-2.0 | The host name for Xauthority matching. Apache-2.0 is compatible with AGPL-3.0. |
| `rustix`, `linux-raw-sys` (through x11rb) | Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT | (Linux) |
| `libc` 0.2.191 | MIT OR Apache-2.0 | `mmap` for the shared-memory segment; DRM, dma-buf and uinput ioctls; `dlopen` (Linux) |
| `windows` 0.62.2 and its `windows-*` crates | MIT OR Apache-2.0 | DXGI, Direct3D 11, GDI, `SendInput`, desktops, pipes, Job Objects, WTS, the notice bar (Windows) |
| `serde`, `serde_json`, `log` and their dependencies | MIT OR Apache-2.0 (`memchr`: Unlicense OR MIT; `zmij`: MIT; `unicode-ident`: (MIT OR Apache-2.0) AND Unicode-3.0) | Control messages, logging |

Test-only crates (not in the agent binary): `zune-jpeg` (MIT OR Apache-2.0 OR Zlib), `png` (MIT OR Apache-2.0), `tempfile` (MIT OR Apache-2.0).

## Independent JPEG Group

The `jpeg-encoder` crate's forward DCT (`src/fdct.rs` and `src/avx2/fdct.rs`) is ported from mozjpeg and the IJG JPEG library. As the IJG licence asks of programs distributed as executables:

> This software is based in part on the work of the Independent JPEG Group.

The console's licences page should show the same line once the desktop ships.

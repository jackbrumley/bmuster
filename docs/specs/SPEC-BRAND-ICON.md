# SPEC-BRAND-ICON: Light by default, and a light radar icon from one drawing

**Status:** `IMPLEMENTED (v0.4.9)` · approved 2026-11-10 (Jack: "default the whole application to light mode by default unless someone changes the toggle to system, then we can just remember that, or dark mode and we can remember that"; a new icon in the light-mode radar style, "white radar with a couple of dark green dots on it, and a beam that's spinning halfway around", from the approved draft). See "As built" at the end.

## Problem

1. A new visitor gets whatever their device prefers, and System is "no saved value", so BMuster cannot tell "never chose" from "chose System". Jack wants light unless someone picks otherwise.
2. The app icon is the old dark tile with a lime beam. The console's loading radar (`src/lib/ui/radar-spinner.svelte`, SPEC-LOADING) is now the brand look, and the icon should match it. Today the icon files are copied by hand (favicon, PWA icons, docs site, error page, agent page, tray pixels drawn in Rust), so they drift.

## Behaviour

1. **Theme start-up.** `<html>` is `data-theme="light"` in the markup, so a new visitor sees light before any script runs (no dark flash). The start-up script in `src/app.html` reads `localStorage['bmuster-theme']`: `dark` sets dark; `system` removes `data-theme`, so the page follows the device; anything else (nothing saved, `light`, an unknown value) stays light. `src/error.html` does the same.
2. **Browser bar colour.** The two `theme-color` metas are light first: the light one applies by default and the dark one is off (`media="not all"`). For a dark or system choice the start-up script and the switch set their `media` to match (system: the two `prefers-color-scheme` queries). The web manifest's colours are light.
3. **Theme switch.** System, Light and Dark are all saved (`system`, `light`, `dark`). Light shows as chosen for a new visitor.
4. **One source drawing.** `docs/logo.svg` is the icon: a white rounded tile with a faint edge, two soft grey-green rings (`#657061`), a dark green beam (`#46720e`) with a sweep fading over half a turn, a bright blip with a halo, a faint blip and a centre dot. Its parts carry ids.
5. **`npm run icons:generate`** (`scripts/icons-generate.ts`, plain `node`) writes every icon file from it. A small version for 32px and below drops the inner ring, the glow, the halo and the faint blip, thickens the ring and beam and keeps a short sweep. It is a developer step; the generated files are committed.
6. **Agent.** The Linux tray offers the small mark at 22, 32 and 48px, embedded as raw ARGB. The agent's local page shows the small mark inline.

## Acceptance criteria

| #   | Criterion                                                                                                        | Named test                                                             |
| :-- | :--------------------------------------------------------------------------------------------------------------- | :--------------------------------------------------------------------- |
| T1  | A new visitor starts light, with the light browser bar colour.                                                   | `theme-switch.svelte.test.ts` "T1"                                     |
| T2  | A saved `dark`, `light` or `system` is applied before first paint; an unknown value stays light.                 | `theme-switch.svelte.test.ts` "T2"                                     |
| T3  | The switch shows Light for a new visitor.                                                                        | `theme-switch.svelte.test.ts` "T3"                                     |
| T4  | The switch stores each choice (System included) and a reload restores it.                                        | `theme-switch.svelte.test.ts` "T4"                                     |
| T5  | The error page starts light and honours the same choices.                                                        | `theme-switch.svelte.test.ts` "T5"                                     |
| I1  | Every committed SVG icon is exactly what the generator makes from `docs/logo.svg`, which keeps the light look.   | `tests/unit/icons.test.ts` "I1"                                        |
| I2  | The error page carries the current logo.                                                                         | `tests/unit/icons.test.ts` "I2"                                        |
| I3  | Each PNG icon has its size; the manifest and layout name only files that exist.                                  | `tests/unit/icons.test.ts` "I3"                                        |
| I4  | The console logo uses the small mark at 32px and below, and keeps its size in light and dark, phone and desktop. | `logo.svelte.test.ts` "I4"                                             |
| I5  | The tray icons are ARGB of 22, 32 and 48px with an opaque tile.                                                  | `icons.test.ts` "I5", Rust `each_tray_icon_is_square_argb_of_its_size` |

## Security notes

None: the icon and theme are presentation only. The tray change swaps embedded pixels; it changes no tray behaviour.

## As built

- **Generated files** (all from `docs/logo.svg`): `static/brand/bmuster-logo.svg` (full mark, the console logo above 32px), `static/favicon.svg` and `docs/favicon.svg` (small mark), `static/brand/icon-192.png` and `icon-512.png` (full mark, rounded tile), `static/apple-touch-icon.png` (180px, tile filling the square, since iOS rounds it), the logo data URI in `src/error.html`, `agent/crates/agent/assets/logo-small.svg` (the agent's local page) and `agent/crates/agent/assets/tray-22.argb`, `tray-32.argb`, `tray-48.argb`.
- **Rasterising** uses the Chromium Playwright already installs for the browser tests (canvas pixels and PNGs), not Inkscape or ImageMagick, so the command needs no system tool. The output is byte-for-byte stable across runs. The pure transforms live in `scripts/icons/drawing.ts` so the unit test can check the committed files.
- **Console logo** (`src/lib/ui/logo.svelte`) is now an `<img>` of the generated file instead of an inline copy of the drawing, so there is one drawing; the `--logo-*` tokens went with it. The error page keeps needing no request, so it carries the full mark as a data URI.
- **Removed:** `scripts/brand-icons.ts` and `npm run brand:icons` (replaced), `src/lib/assets/favicon.svg` (an unused Svelte logo) and the hygiene layout's `assets` folder.
- **Windows tray** still shows the stock information icon: it uses no `.ico`, and building a custom icon needs Windows-only code that could not be compiled here. A follow-up can load the same pixels with `CreateIcon`. (Done: see "Windows icon" below.)
- **Linux `.desktop` launchers** still name the stock `network-workgroup` icon; installing an icon file is installer work for a follow-up.

- **Linux menu icon (added for 0.4.12).** `npm run icons:generate` also writes `agent/crates/agent/assets/bmuster.svg` (the full mark). The agent installs it as `/usr/share/icons/hicolor/scalable/apps/bmuster.svg` with the autostart and applications-menu entries (rewritten on every start when different, removed at uninstall), and both entries say `Icon=bmuster` instead of the stock `network-workgroup`.

## Version 2: the night radar, with no tile (IMPLEMENTED (v0.4.15))

Approved 2026-11-11. Jack: the other apps' icons are "the naked shape of the icon"; BMuster's should be "just the circular element", with no square behind it. From the options page he chose D, the night disc, and accepted the recommendations: the mark on its own on bmuster.com, a brighter rim at small sizes, and the Linux tray drawing the SVG by name.

1. **The drawing.** `docs/logo.svg` is a round dark radar screen (`face`, `#13200f`, a faint lime rim) with no tile. The rings are `#7f9a72`; the beam, sweep and centre are lime (`#a3e635`); the blips are pale lime (`#d9f99d`). Layout (Jack chose option F, 2026-11-11): the beam points to four o'clock with a trail behind it that fades evenly over almost half a turn and glows brightest at the beam (Jack: "brighter on its leading edge", without shortening it), and four contacts fade with age: the newest bright with a halo, two more in the top half, and a faint old one at seven o'clock, so no part of the disc is empty. The view box is cropped to the disc (`26 26 204 204`), so the mark fills its icon edge to edge.
2. **One drawing at every size** (Jack, 2026-11-11, after comparing: "Way happier with that. Let's use that everywhere"). The separate small version is gone: the favicon, the agent's local page logo, the tray SVG and the tray pixels are all the full drawing at their size. The console logo uses `bmuster-logo.svg` at every size. I4 now checks the one mark at 32px and 48px.
3. **iPhone icon.** iOS wants an opaque square, so `apple-touch-icon.png` fills the square with the disc's colour and iOS rounds it.
4. **Linux tray by name.** The tray sends `IconName=bmuster-tray` as well as the pixels. The agent installs the small mark as `/usr/share/icons/hicolor/scalable/apps/bmuster-tray.svg` beside `bmuster.svg` (rewritten when different, removed at uninstall). A panel that finds it draws it sharp at any size; one that does not uses the 22, 32 and 48px pixels.
5. **bmuster.com.** The hero shows the mark on its own at 92px with a soft green shadow, no tile.

| #   | Criterion                                                                                                  | Named test                                                             |
| :-- | :--------------------------------------------------------------------------------------------------------- | :--------------------------------------------------------------------- |
| I1  | (Replaces the light-look check.) The drawing is the night radar: a dark `face` disc, no `tile`, lime beam. | `tests/unit/icons.test.ts` "I1"                                        |
| I5  | (Replaces "opaque tile".) Each tray icon is ARGB of its size with an opaque centre and clear corners.      | `icons.test.ts` "I5", Rust `each_tray_icon_is_square_argb_of_its_size` |
| I6  | The tray names `bmuster-tray`, and the agent installs `bmuster-tray.svg` with the other shortcuts.         | `icons.test.ts` "I1" (generated file), Rust `shortcuts` tests          |

## Windows icon (IMPLEMENTED (v0.4.19))

Asked for 2026-11-11, with the Windows tray starter (SPEC-TRAY-SESSIONS, Windows). The Windows tray showed the stock information icon (and the stock warning icon while someone was connected), and `bmuster-agent.exe` had no icon of its own.

1. **One icon file.** `npm run icons:generate` also writes `agent/crates/agent/assets/bmuster.ico`: the same drawing at 16, 20, 24, 32, 40, 48, 64 and 256px (every size Windows asks for from 100% to 400% scaling). The 256px image is a PNG; the others are 32-bit DIBs with straight alpha and a clear mask, the classic layout every Windows version reads. The writer is `scripts/icons/ico.ts`, a few lines of plain TypeScript, so the command still needs no image tool.
2. **The tray** draws the mark from the icon file embedded in the program. It takes the DIB of the notification area's size (`SM_CXSMICON`, with the tray system-DPI aware) or the next larger, and makes the icon with `CreateIconFromResourceEx`. While someone is connected to the screen it shows the same mark with the Linux tray's red dot (`connected_icon`, now shared), instead of the stock warning icon. The tooltip and menu are unchanged.
3. **The program's icon.** `build.rs` makes a compiled resource file (`.res`) from `bmuster.ico` for Windows targets: one `RT_ICON` per image and an `RT_GROUP_ICON` (id 1) listing them, written in Rust (`src/tray/resource.rs`), so the build needs no resource compiler and no new crate. The MSVC linker takes a `.res` file as an input, so the release build (`x86_64-pc-windows-msvc`) links it into `bmuster-agent.exe`, and Explorer, the Start menu shortcut and Task Manager show the mark. The output was checked byte for byte against `zig rc` (an `rc.exe`-compatible compiler) compiling `1 ICON "bmuster.ico"`: identical.
4. **GNU builds** (`x86_64-pc-windows-gnu`, used here only to lint) write the resource file but do not link it: MinGW's `ld` takes resources only as objects made by `windres`, which is not installed. Their program has no icon; their tray still draws the mark.

| #   | Criterion                                                                                                                                                            | Named test                                                                |
| :-- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :------------------------------------------------------------------------ |
| I7  | `bmuster.ico` holds every size from the drawing; at 32 and 48px its pixels are the tray's ARGB files.                                                                | `tests/unit/icons.test.ts` "I7"                                           |
| W1  | The committed icon has every Windows size, a PNG only at 256px.                                                                                                      | Rust `tray::ico::tests::the_windows_icon_has_every_size`                  |
| W2  | The program's resource file holds every image of the icon and a group naming them.                                                                                   | Rust `tray::resource::tests::the_program_icon_resource_holds_every_image` |
| W3  | The tray picks the notification area's size or the next larger DIB, never the PNG.                                                                                   | Rust `tray::icon::tests::the_tray_picks_its_size_from_the_icon`           |
| W4  | The connected tray icon is the mark with the red dot; the 32px DIB matches the Linux tray's pixels.                                                                  | Rust `tray::icon::tests::the_connected_tray_icon_adds_the_red_dot`        |
| W5  | The icon file writer lays out DIBs and the directory as Windows reads them, and reads them back.                                                                     | `tests/unit/ico.test.ts` "W5"                                             |
| W6  | The program also carries its version details (BMuster, BMuster agent, its version, AGPLv3 copyright), byte for byte what `rc.exe` makes from the same `VERSIONINFO`. | Rust `tray::resource::tests::the_program_carries_its_version_details`     |

5. **Version details** (added 0.4.25, after Microsoft Defender quarantined the unsigned agent on a new machine): the same `.res` file carries an `RT_VERSION` resource (company and product BMuster, description "BMuster agent", file and product version from `BMUSTER_VERSION`, original filename, AGPLv3 copyright, bmuster.com). Explorer shows it under Properties > Details, and antivirus products weigh a program with none as more suspicious. Checked byte for byte against `zig rc` compiling the same `VERSIONINFO`: identical.

**Security notes.** Presentation only: the icon bytes are fixed at build time and come from the committed drawing. No tray behaviour changes.

**Only linted, not run:** the Win32 calls that make and show the tray icon (`CreateIconFromResourceEx`, `GetSystemMetrics`, `SetProcessDpiAwarenessContext`, `DestroyIcon`) and the MSVC link of the resource file. Release test: the installed `bmuster-agent.exe` shows the mark in Explorer; the tray shows the mark, sharp at 100% and 150% scaling, and the red-dot mark while a desktop session is open.

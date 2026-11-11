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
- **Windows tray** still shows the stock information icon: it uses no `.ico`, and building a custom icon needs Windows-only code that could not be compiled here. A follow-up can load the same pixels with `CreateIcon`.
- **Linux `.desktop` launchers** still name the stock `network-workgroup` icon; installing an icon file is installer work for a follow-up.

- **Linux menu icon (added for 0.4.12).** `npm run icons:generate` also writes `agent/crates/agent/assets/bmuster.svg` (the full mark). The agent installs it as `/usr/share/icons/hicolor/scalable/apps/bmuster.svg` with the autostart and applications-menu entries (rewritten on every start when different, removed at uninstall), and both entries say `Icon=bmuster` instead of the stock `network-workgroup`.

## Version 2: the night radar, with no tile (IMPLEMENTED (pending release))

Approved 2026-11-11. Jack: the other apps' icons are "the naked shape of the icon"; BMuster's should be "just the circular element", with no square behind it. From the options page he chose D, the night disc, and accepted the recommendations: the mark on its own on bmuster.com, a brighter rim at small sizes, and the Linux tray drawing the SVG by name.

1. **The drawing.** `docs/logo.svg` is a round dark radar screen (`face`, `#13200f`, a faint lime rim) with no tile. The rings are `#7f9a72`; the beam, sweep and centre are lime (`#a3e635`); the blips are pale lime (`#d9f99d`). Layout (Jack chose option F, 2026-11-11): the beam points to four o'clock with a 150 degree trail behind it, and four contacts fade with age: the newest bright with a halo, two more in the top half, and a faint old one low on the left, so no part of the disc is empty. The view box is cropped to the disc (`26 26 204 204`), so the mark fills its icon edge to edge.
2. **Small version.** The same drops and thickening as before (keeping the two newest contacts and the half of the trail nearest the beam), plus a wider, brighter rim (`stroke-opacity` 0.6) so the disc's edge shows on a black panel.
3. **iPhone icon.** iOS wants an opaque square, so `apple-touch-icon.png` fills the square with the disc's colour and iOS rounds it.
4. **Linux tray by name.** The tray sends `IconName=bmuster-tray` as well as the pixels. The agent installs the small mark as `/usr/share/icons/hicolor/scalable/apps/bmuster-tray.svg` beside `bmuster.svg` (rewritten when different, removed at uninstall). A panel that finds it draws it sharp at any size; one that does not uses the 22, 32 and 48px pixels.
5. **bmuster.com.** The hero shows the mark on its own at 92px with a soft green shadow, no tile.

| #   | Criterion                                                                                                  | Named test                                                             |
| :-- | :--------------------------------------------------------------------------------------------------------- | :--------------------------------------------------------------------- |
| I1  | (Replaces the light-look check.) The drawing is the night radar: a dark `face` disc, no `tile`, lime beam. | `tests/unit/icons.test.ts` "I1"                                        |
| I5  | (Replaces "opaque tile".) Each tray icon is ARGB of its size with an opaque centre and clear corners.      | `icons.test.ts` "I5", Rust `each_tray_icon_is_square_argb_of_its_size` |
| I6  | The tray names `bmuster-tray`, and the agent installs `bmuster-tray.svg` with the other shortcuts.         | `icons.test.ts` "I1" (generated file), Rust `shortcuts` tests          |

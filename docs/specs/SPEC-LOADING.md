# SPEC-LOADING: A shared loading overlay with a radar sweep

**Status:** `IMPLEMENTED (pending release)` · approved 2026-11-09 (Jack: "a loading spinner or radar animation … a soft foggy overlay or something modern … use it on things like the update page"). See "As built" at the end.

## Problem

Waiting states are plain text today ("Checking…", the server restart on Updates), so a long wait looks like a stuck page. BMuster needs one shared, calm loading look that matches the console in light and dark themes.

## Behaviour

1. **`RadarSpinner`** (`src/lib/ui/radar-spinner.svelte`): a round radar, sizes `small` (24px, inline in buttons and rows), `medium` (48px) and `large` (96px). A soft conic-gradient sweep turns once every 2.4 s over two faint concentric rings, and a small blip fades in and out on the sweep. Colours come only from tokens (`--brand` for the sweep, `--border`/`--text-muted` tints for the rings); new tokens, if any, are `light-dark()` in `design-tokens.css`.
2. **`LoadingVeil`** (`src/lib/ui/loading-veil.svelte`): covers its parent block (a `Panel` or a page section) with a soft, foggy layer: a translucent `--surface-overlay` tint with `backdrop-filter: blur()` and a slow drifting haze, and a large `RadarSpinner` with a title and an optional detail line beneath (for example "Installing 0.4.5", "Waiting for the server to come back"). It fades in after 150 ms (so quick loads never flash) and fades out when done. Props: `active`, `title`, `detail` (a string or `undefined`, passed explicitly).
3. **Accessibility:** the veil has `role="status"`, `aria-live="polite"` and `aria-busy="true"` on the covered block while active; the title is the accessible text. With `prefers-reduced-motion: reduce`, the sweep and haze stop and the radar shows a gentle opacity pulse instead.
4. **Where it is used:**
   - Updates page: the whole server-update panel while an installed update runs and the server restarts (the existing restart monitor drives it; the detail line shows the updater's current step from `update-status.json`).
   - Updates page: Check for updates (small spinner in the button while checking).
   - Manage: the Logs panel's first load and Run checks (small spinner in the button, veil over the Checks card while results are awaited).
   - Machine Desktop tab: while connecting and waiting for the first frame (replacing the plain "Connecting" text).
   - Any other page block that shows a "Loading…" text today, found with a search, uses these two components instead (one path).
5. Works below 768px and on desktop, light and dark; no layout shift when the veil appears.

## Acceptance criteria

| #   | Criterion                                                                                                                                   | Named test                                          |
| :-- | :------------------------------------------------------------------------------------------------------------------------------------------ | :-------------------------------------------------- |
| L1  | `RadarSpinner` renders each size, uses only tokens, and stops animating with reduced motion.                                                | `radar-spinner.svelte.test.ts`                      |
| L2  | `LoadingVeil` appears only after 150 ms, shows title and detail, sets `role=status` and `aria-busy`, and leaves when inactive.              | `loading-veil.svelte.test.ts`                       |
| L3  | The Updates page shows the veil with the updater's step during an installed update and restart, and removes it when healthy or rolled back. | `updates-page.svelte.test.ts`                       |
| L4  | Check for updates, Logs first load, Run checks and the Desktop tab connect state use the new components.                                    | the pages' existing tests, extended                 |
| L5  | No page keeps its own spinner or "Loading…" text.                                                                                           | hygiene rule `loading-text-forbidden` with fixtures |

## As built

- **`RadarSpinner`** takes one prop, `size`. It is always decoration (`aria-hidden`): the button label or the veil title beside it is the accessible text. The sweep is a conic gradient in `--brand` that brightens towards its leading edge, over two `--muted` rings, a faint brand glow and a centre dot; the blip sits 60° clockwise of the top and flares as the sweep passes. Reduced motion stops the sweep and blip and breathes the whole radar's opacity. No new tokens: tints are `color-mix()` of existing tokens.
- **`LoadingVeil`** also takes `children` (a `Snippet`, or `undefined`). It wraps the block it covers instead of overlaying a parent, so no caller has to make a `Panel` positioned. The block and the veil share one grid cell, so the block is at least as tall as the veil's message and nothing moves when the veil fades in. The covered block is `aria-busy` and `inert` while active. With `children: undefined` the veil is the whole block (a folder being read; the Desktop stage, where it fills an absolutely placed layer so it still shows in full screen). The fog is `--surface-overlay` at 58% with a 10px backdrop blur, and three soft clouds (brand, surface, muted) drift over 16 s. It fades in after 150 ms and out over 240 ms.
- **Updates:** the server panel stays in place under the veil ("Updating BMuster to 0.4.5"), with the "Reconnecting automatically" notice below it. The restart monitor gained `onProgress`: the detail line shows the updater's message once it is from this update, and "Waiting for the server to come back" while the server cannot be reached. A healthy new version reloads the page (`reload-page.ts`, so the test can watch it); a rollback or failure now lifts the veil and refreshes the data instead of reloading, since the same version is running. Check for updates stays visible and shows the small radar with "Checking for updates"; Update now hides while busy.
- **Manage:** the veil covers the Logs panel until its first read, the Checks card during its first read ("Reading the checks") and after Run checks until new results arrive ("Running the checks", with "<machine> sends the results within a minute."). Run checks shows the small radar and "Running checks". The Sessions card uses the veil for its first read too.
- **Desktop tab:** the stage shows the veil while starting or connecting ("Connecting to <machine>"), reconnecting, waiting for the machine, and until the first picture ("Waiting for the first picture"); the stage is `aria-busy` meanwhile. The toolbar's small status text is unchanged.
- **Other waits found by search:** the Files tab's drives and folder reads use the veil (they had "Loading drives…" and "Loading…"). One-line waits get the small radar beside their text: Checking the code, Making a join code (Add machine and Install manually), Waiting for a machine to join, Getting the code (local page), Making a reinstall code, and the join page's "Waiting for your computer to connect". Busy labels inside form buttons ("Saving…", "Sending…") and the terminal and upload status words are left as they are.
- **Hygiene rule `loading-text-forbidden`** (§12) flags "Loading…", "Working…" and "Please wait…" (with `…` or `...`) in browser code, and `@keyframes` named like a spinner (`spin`, `loader`, `loading`), everywhere except the two components. AGENTS.md §12 gained a "Waiting" line.
- **Reduced motion test:** the `ui` test project has a browser command, `emulateReducedMotion`, that sets Playwright's `reducedMotion` media emulation.
- **Radar alone on Updates (2026-11-10, Jack: "if we just showed the radar icon alone whilst the update was happening, I think that would feel really clean and modern").** `LoadingVeil` gained a mandatory `caption: 'shown' | 'hidden'`. Hidden keeps the title and detail as the status a screen reader hears but shows only the radar; with no block beneath, there is no fog either. While the server updates, the Updates page shows that radar alone under its header: the server panel, the "Reconnecting automatically" notice and the rest of the page are gone until the update ends. Every other wait keeps `caption="shown"`. The release notes show the newest version, with earlier versions folded under "Earlier versions (N)".

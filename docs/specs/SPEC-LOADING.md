# SPEC-LOADING: A shared loading overlay with a radar sweep

**Status:** `APPROVED` 2026-11-09 (Jack: "a loading spinner or radar animation … a soft foggy overlay or something modern … use it on things like the update page").

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

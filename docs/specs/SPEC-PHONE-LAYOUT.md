# SPEC-PHONE-LAYOUT: No console page scrolls sideways on a phone

**Status:** `IMPLEMENTED (v0.4.22)` 2026-11-12 · cross-cutting UI criterion for every console page · asked for by Jack after three phone bugs of the same kind in one week

## Problem

Three bugs in the week before 0.4.21 had one cause: a grid or flex track grew to the width of text it could not wrap (a long machine name, a long folder name, an "In use" list), so the whole page scrolled sideways on a phone. The machine header (`dabd32c`), the Storage browser and the Machines table (`72791f1`) were each fixed on their own, after someone found them by hand.

## Rule

Every console page, at 360 px wide, fits the screen with the longest real-world text: `document.documentElement.scrollWidth` is at most 360. A track that holds text gets `grid-template-columns: minmax(0, 1fr)` or `min-width: 0`, and text with no break point gets `overflow-wrap: anywhere` (or scrolls inside its own scroller, as tab rows and path bars do).

## Acceptance criteria

| #   | Criterion                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Test                                                                                                       |
| :-- | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :--------------------------------------------------------------------------------------------------------- |
| U1  | Every console page and machine tab, rendered inside the real console frame (and machine layout) at 360 × 780 with long machine names, hostnames, folder and file names, people, groups, descriptions and "In use" lists, does not scroll sideways. Covered: Machines (cards and table), Overview, Terminal, Desktop, Files (drives, and a folder two levels down), Storage (drives, and a folder two levels down), Notes, Manage, Activity, Add machine, Groups, Access, Users, Sign-in providers, Settings, Email, Notifications, Diagnostics tokens, Updates and More. A new console page is added to the test's list. | `src/routes/(console)/phone-overflow.svelte.test.ts` and `phone-overflow-machine-tabs.svelte.test.ts` "U1" |

## As built

- The pages render through `src/routes/(console)/console-frame.svelte` (the console layout, and for machine tabs the machine layout), with the long data in `tests/helpers/long-data.ts`. A failure lists the elements that reach past the right edge, leaving out content inside a scroller.
- The test found one more case: the Overview's disk bars (`src/lib/ui/usage-bar.svelte`) grew to a long mount name. The bar's label now wraps.
- With the 0.4.20 Storage fix (`minmax(0, 1fr)` in `storage-browser.svelte`) taken out, U1 fails for Storage, so it would have caught that bug.

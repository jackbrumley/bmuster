# SPEC-DESKTOP-FLOATING: A movable controls button in full screen on phones and tablets

**Status:** `IMPLEMENTED (pending release)` · approved 2026-11-10 (Jack: "when you're full screen on mobile you can still send these keys somehow easily … a floating action button that you can move anywhere on the screen that you want … a movable sort of home button that allows you to open up the options and do more in full screen when on mobile. 50% of the time people are going to be providing remote support on their mobile phones so we do need to make this easy.") · **security work:** the controls send input to another person's computer. See "As built" at the end.

## Problem

In full screen the page's own bar is outside the full-screen element, so the desktop tab shows the full-screen bar (`full-screen-bar.svelte`) at the top centre of the screen. On a phone it is a bubble that hides after three seconds, comes back only when a finger taps the screen (which also clicks the remote machine), and covers the top of the remote picture, where window title bars and menus live. The phone key bar and its keyboard toggle sit under the screen, outside full screen, so a phone in full screen has no way to type, send Esc or Ctrl+Alt+Del, or switch between trackpad and touch input. Half of remote support happens on phones.

## Behaviour

1. **When.** In full screen, a device matching `(pointer: coarse), (max-width: 899px)` gets one round floating button instead of the full-screen bar. Any other device (a desktop computer with a mouse and a wide window) keeps the full-screen bar unchanged.
   - **Why both tests:** `pointer: coarse` catches tablets and phones in landscape whose width passes 900px (an iPad is 1024px or wider), where a small top bar is just as hard to use with a finger. The 900px width is the console's sidebar breakpoint and the width below which the phone key bar shows, so a narrow desktop window behaves like the phone layout it already shows. A laptop with a touch screen and a mouse reports `pointer: fine` and keeps the bar.
2. **The button** is 48px, round, brand-coloured, with the Tabler menu icon, `aria-label="Session controls"`, `aria-expanded` and the standard visible focus ring. It sits on the left or right edge of the screen, inside the safe-area insets plus a small gap, at a remembered height. It starts on the right edge, halfway down.
3. **Dragging.** A finger (or mouse) pressed on the button and moved more than 8px drags it anywhere on the screen. On release it snaps to the nearer left or right edge and keeps its height, clamped inside the safe area. A press that moves less than 8px is a tap. Dragging closes the sheet. The button's events never reach the remote machine: the screen's input only takes events whose target is the screen itself (`screen-input.ts`), and while the button is held the drag takes its pointer's events on the window in the capture phase and stops them there, so even a mouse dragged across the screen sends nothing.
4. **Remembered per browser.** The edge and the height (as a fraction of the space the button can travel, so it survives rotation) are kept in `localStorage` under `bmuster.desktop.floatingButton`, read and written inside `try`/`catch` like the other per-viewer preferences (`machines-view.ts`, the terminal's font size). Blocked storage or a value that does not parse gives the default position.
5. **The sheet.** Tapping the button opens a compact sheet on the button's side, below the button when it is in the top half of the screen and above it otherwise, so it never covers the button. It is at most half the screen's height and scrolls inside. It holds, as Panels:
   - **Actions:** the session mode ("Control" or "View only"), touch input trackpad or tap (control), picture settings (opens the settings in the sheet), Take control or Switch to view only (when the person may control), Leave full screen and Disconnect. Disconnect uses the page's existing `confirmAction`.
   - **Choose screen** when the machine has more than one display.
   - **Phone keys** (control): the phone key bar (`key-bar.svelte`, reused) with its keyboard toggle, Esc, Tab, sticky Ctrl and Alt, the Windows key and the arrows.
   - **Keys** (control): the Keys menu (`keys-menu.svelte`, reused): the everyday pills and More.
   - **Picture settings** (`desktop-settings.svelte`, reused) while toggled on.
6. **Typing.** Showing the phone keyboard focuses the key bar's hidden typing area, as outside full screen. While it is open the sheet folds to just the key bar and moves to the top of the screen, so it stays above the phone's keyboard, and the typing area keeps focus while keys on the bar are pressed.
7. **Closing.** Tapping the button again or anywhere outside the sheet closes it. The tap outside lands on a transparent backdrop, so it never clicks the remote machine. Leave full screen and Disconnect close it too.
8. **Watch-only sessions** get the button and the sheet without the touch input toggle, the phone keys, the keyboard or the Keys menu. The server and agent still drop input from watch-only tickets (SPEC-DESKTOP 7); hiding is a convenience on top of the check.
9. Works in light and dark (tokens only), portrait and landscape, with no horizontal page scroll; every touch target is at least 40px.

## Acceptance criteria

| #   | Criterion                                                                                                                                                               | Named test                                                                |
| :-- | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :------------------------------------------------------------------------ |
| F1  | In full screen at phone width the floating button shows and the full-screen bar does not; on a desktop-width window with a mouse the bar shows and the button does not. | `desktop.svelte.test.ts` "F1"                                             |
| F2  | Dragging the button moves it, snaps it to the nearer edge at the height it was let go, and sends no input to the machine.                                               | `floating-controls.svelte.test.ts` "F2", `desktop.svelte.test.ts` "F2"    |
| F3  | The position is saved per browser and read back; blocked storage or a bad value gives the default (right edge, halfway).                                                | `floating-position.test.ts` "F3", `floating-controls.svelte.test.ts` "F3" |
| F4  | A tap opens the sheet; a second tap or a tap outside closes it; a tap outside sends nothing to the machine.                                                             | `floating-controls.svelte.test.ts` "F4", `desktop.svelte.test.ts` "F4"    |
| F5  | For a control session the sheet has the actions, phone keys and Keys menu, and its Keys send the same messages as the Keys menu.                                        | `floating-controls.svelte.test.ts` "F5"                                   |
| F6  | For a watch-only session the sheet has no touch input toggle, keyboard, phone keys or Keys menu.                                                                        | `floating-controls.svelte.test.ts` "F6"                                   |
| F7  | On a 375×667 phone, portrait and landscape, the open sheet is at most half the screen's height and the page has no horizontal scroll.                                   | `floating-controls.svelte.test.ts` "F7"                                   |
| F8  | Disconnect in the sheet asks first and then ends the session; Leave full screen leaves it.                                                                              | `desktop.svelte.test.ts` "F8"                                             |
| F9  | Show the keyboard focuses the typing area, folds the sheet to the key bar, and typed text goes to the machine as `text`.                                                | `floating-controls.svelte.test.ts` "F9"                                   |

## Security notes

- The sheet only offers controls the page already has (Keys menu, phone key bar, mode switch, picture settings, Disconnect); no new message type, permission or agent change.
- Watch-only stays enforced by the session ticket on the server and the agent.
- The drag and the backdrop are separate targets from the screen, so moving the button or closing the sheet never clicks on the remote machine.

## Open questions

None.

## As built (2026-11-10)

- `floating-controls.svelte` (the button, its drag, the backdrop and the sheet) and `floating-position.ts` (the saved position and the snap) sit beside the desktop route. The page picks it or `full-screen-bar.svelte` with Svelte's `MediaQuery` on the query above.
- There is no shared sheet or popover in `src/lib/ui`, so the sheet is a transparent scroll container of the shared `Panel`s (the same way the full-screen bar shows its blocks), which keeps the route free of a card look of its own.
- `key-bar.svelte` gained an `onkeyboard` prop so the sheet knows when the phone keyboard opens and closes; the page passes `undefined`.
- The page's start panel (Connect and Watch only) moved to `desktop-start.svelte` to keep `+page.svelte` from growing.
- In full screen the test browser's frame grows to the whole headless screen, so `desktop.svelte.test.ts` stands in for a phone by making the touch-layout query match (`pretendTouchScreen`); the component tests size the screen to 375×667 themselves.
- iPhone Safari does not support full screen for page elements (only for video), so on an iPhone the button shows only where the browser allows full screen; Android Chrome and iPadOS Safari do.

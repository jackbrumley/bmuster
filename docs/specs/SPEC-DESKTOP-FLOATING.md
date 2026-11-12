# SPEC-DESKTOP-FLOATING: A movable controls button in full screen on phones and tablets

**Status:** `IMPLEMENTED (v0.4.11)`, redesigned for phones in "Phone controls, redesigned (option A)" (pending release) · approved 2026-11-10 (Jack: "when you're full screen on mobile you can still send these keys somehow easily … a floating action button that you can move anywhere on the screen that you want … a movable sort of home button that allows you to open up the options and do more in full screen when on mobile. 50% of the time people are going to be providing remote support on their mobile phones so we do need to make this easy.") · **security work:** the controls send input to another person's computer. See "As built" at the end.

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
10. **No browser full screen (iPhone).** Where `document.fullscreenEnabled` is false, or `requestFullscreen` is missing or refused, Full screen makes the stage fill the window instead: `position: fixed` over the whole viewport (`100dvh`) above the console's frame, the picture inset by the safe areas, and the page behind it unable to scroll. The floating button and sheet show exactly as in real full screen, and Leave full screen (or the session ending) restores the page. The page has one full-screen state meaning either kind, so nothing downstream tells them apart.

## Acceptance criteria

| #   | Criterion                                                                                                                                                                         | Named test                                                                |
| :-- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :------------------------------------------------------------------------ |
| F1  | In full screen at phone width the floating button shows and the full-screen bar does not; on a desktop-width window with a mouse the bar shows and the button does not.           | `desktop.svelte.test.ts` "F1"                                             |
| F2  | Dragging the button moves it, snaps it to the nearer edge at the height it was let go, and sends no input to the machine.                                                         | `floating-controls.svelte.test.ts` "F2", `desktop.svelte.test.ts` "F2"    |
| F3  | The position is saved per browser and read back; blocked storage or a bad value gives the default (right edge, halfway).                                                          | `floating-position.test.ts` "F3", `floating-controls.svelte.test.ts` "F3" |
| F4  | A tap opens the sheet; a second tap or a tap outside closes it; a tap outside sends nothing to the machine.                                                                       | `floating-controls.svelte.test.ts` "F4", `desktop.svelte.test.ts` "F4"    |
| F5  | For a control session the sheet has the actions, phone keys and Keys menu, and its Keys send the same messages as the Keys menu.                                                  | `floating-controls.svelte.test.ts` "F5"                                   |
| F6  | For a watch-only session the sheet has no touch input toggle, keyboard, phone keys or Keys menu.                                                                                  | `floating-controls.svelte.test.ts` "F6"                                   |
| F7  | On a 375×667 phone, portrait and landscape, the open sheet is at most half the screen's height and the page has no horizontal scroll.                                             | `floating-controls.svelte.test.ts` "F7"                                   |
| F8  | Disconnect in the sheet asks first and then ends the session; Leave full screen leaves it.                                                                                        | `desktop.svelte.test.ts` "F8"                                             |
| F9  | Show the keyboard focuses the typing area, folds the sheet to the key bar, and typed text goes to the machine as `text`.                                                          | `floating-controls.svelte.test.ts` "F9"                                   |
| F10 | Without the browser's full screen (disabled or refused), Full screen fills the window with the floating button, locks the page's scroll, and Leave full screen restores the page. | `desktop.svelte.test.ts` "F10"                                            |

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
- iPhone Safari does not support full screen for page elements (only for video), so there the stage fills the window (behaviour 10). `full-screen.svelte.ts` (`FullScreen`) owns both kinds: `on` is the page's one `fullScreen`, `toggle` tries the browser's full screen when `fullscreenEnabled` and falls back to filling on a refusal, `leave` undoes either, and `attach` follows `fullscreenchange`. The stage sits at z-index 20, over the console frame (10) and under the toasts (30); confirmation dialogs open in the top layer above it. Not yet tried on a real iPhone.

## Phone controls, redesigned (option A)

**Status:** `PENDING RELEASE` · approved 2026-11-12 (Jack tested the full-screen controls on an Android phone and approved "option A") · **security work:** the gestures send input to another person's computer.

### Problem

On a real Android phone the full-screen controls are hard to use:

- The sheet is a stack of cards in one scroll box of at most half the screen. In landscape that is about 165px, so most controls are hidden with nothing showing that more is there.
- The phone keys sit in a row that scrolls sideways with no hint, so the arrows are out of sight.
- The button can only sit on the left or right edge, where it covers the remote desktop's window buttons.
- There is no right click without two fingers, a drag is easy to miss, and there is no way to zoom in on a small remote screen.

### Behaviour

These replace behaviour 3's snap, 5 (the sheet) and 6 (typing) above. Everything else above still holds.

1. **The button on any edge.** The position is `{ edge: 'left' | 'right' | 'top' | 'bottom', at: 0..1 }`, where `at` is the place along that edge as a fraction of the space the button can travel. On release the button snaps to the nearest of the four edges, keeping its place along it, inside the safe-area insets plus the small gap. The default stays the right edge, halfway down.
2. **Old saved positions.** A position saved before this change (`{ side, at }`) is read as the same place on the left or right edge, by the same reader; the next save writes the new shape. A bad value or blocked storage still gives the default.
3. **The sheet's shape.** When the screen is taller than it is wide (portrait), the sheet is a bottom sheet: the full width of the safe area, anchored at the bottom, at most 70% of the screen's height. Otherwise (landscape) it is a full-height side panel, `min(380px, 50%)` wide, on the button's side: the button's edge when it is on the left or right, or the side nearer the button's centre when it is on the top or bottom. The sheet may cover the button; a tap outside, Escape and the button (when visible) close it.
4. **Tabs.** The sheet opens on a tab bar (a new shared `TabBar` in `src/lib/ui`: a real `tablist` with arrow-key movement, looking like `TabNav`):
   - **Keys** (control only): the keyboard toggle and the phone keys in a grid that wraps to the sheet's width (no sideways scroll), then the Keys menu.
   - **Picture** (while a session runs): Quality, Scale and frame rate.
   - **Screen** (only with more than one display): the screen picker.
   - **Session**: the mode ("Control" or "View only"), the touch input choice (control: Trackpad or Tap to click), Take control or Switch to view only (when the person may control), Leave full screen and Disconnect.

   A control session opens on Keys; a watch-only session (or none) on Session. The chosen tab is kept while full screen lasts; a tab that goes away (Screen after a display is unplugged) falls back to the opening tab.

5. **Scrolling inside.** The tab bar stays put; a tab's content taller than the sheet scrolls inside the sheet, with a fade at the top or bottom edge while there is more to see that way. Content that fits shows no fade.
6. **Typing.** Show the keyboard focuses the key bar's typing area, as before. While the phone's keyboard is open the sheet folds to just the key bar, without the tab bar, and moves to the top of the screen (full width in portrait, the side panel's width in landscape), so it stays above the keyboard. The typing area keeps focus while keys on the bar are pressed.
7. **Gestures on the screen** (touch only; a mouse is unchanged):
   - **Long press** (500 ms, the finger moving less than 10px) right-clicks where the pointer is, in both trackpad and touch modes. Lifting or moving before then does nothing extra.
   - **Trackpad drag:** a touch within 400 ms of a tap (was 350 ms) holds the left button and drags.
   - **Two fingers at normal size:** moving together scrolls (wheel). Spreading or pinching (the distance between them changing by more than 24px before the pair moves 10px) zooms instead.
   - **Pinch zoom** enlarges the picture in the browser only (a CSS transform on the picture; nothing is sent), between 1× and 5×, about the pinch's midpoint, never past the picture's edges. While zoomed, two fingers pan (and pinch) the picture instead of scrolling.
   - **Double two-finger tap** while zoomed goes back to 1×, with no right click. A single two-finger tap still right-clicks; while zoomed its right click waits 400 ms for a possible second tap.
   - **Through the zoom:** every click, drag and move maps to the display pixel under the finger (touch mode), or moves the pointer by the finger's movement over the enlarged picture (trackpad mode, so finer when zoomed). After a two-finger gesture, the finger left down does nothing until all fingers lift.
8. **First-time hint.** The first time a control session shows on a touch device (`pointer: coarse`), a small dismissible hint lists the gestures: tap = click, double-tap and drag = drag, long press = right click, pinch = zoom, two fingers = scroll (or pan when zoomed). Got it hides it and remembers that in `localStorage` (`bmuster.desktop.gestureHint`, inside `try`/`catch`); with storage blocked it hides until the page reloads. It shows above the screen on the page, and over the screen in full screen. A desktop with a mouse never sees it.
9. The logic lives in pure modules with unit tests: the position and snap (`floating-position.ts`), the sheet's shape and scroll cues (`sheet-layout.ts`), the zoom maths (`zoom.ts`), the gestures (`touch-gestures.ts`, moved out of `input.ts`) and the hint's storage (`gesture-hint.ts`).
10. Works below 768px and on desktop, in light and dark (tokens only), with no horizontal page scroll; every touch target is at least 40px.

### Acceptance criteria

These replace F2's snap, F5, F7 and F9 above; F1, F3, F4, F6, F8 and F10 still hold (their tests now open the Session tab first).

| #    | Criterion                                                                                                                                                                                                       | Named test                                                                              |
| :--- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :-------------------------------------------------------------------------------------- |
| FA1  | Released, the button snaps to the nearest of the four edges and keeps its place along it; a drag to the top edge lands it there and is remembered.                                                              | `floating-position.test.ts` "FA1", `floating-controls.svelte.test.ts` "FA1"             |
| FA2  | A saved `{ side, at }` reads as `{ edge: side, at }`; a bad value or blocked storage gives the right edge, halfway.                                                                                             | `floating-position.test.ts` "FA2"                                                       |
| FA3  | Portrait gives a bottom sheet; landscape a side panel on the button's edge, or on the side nearer the button when it sits on the top or bottom edge.                                                            | `sheet-layout.test.ts` "FA3"                                                            |
| FA4  | At 375×667 the open sheet spans the safe width at the bottom and is at most 70% of the height; at 667×375 it is full height, at most 380px and half the width, on the button's side; no horizontal page scroll. | `floating-controls.svelte.test.ts` "FA4"                                                |
| FA5  | A control session has the tabs Keys, Picture and Session (Screen only with more than one display) and opens on Keys; watch-only has Picture and Session and opens on Session; Session holds the actions.        | `floating-controls.svelte.test.ts` "FA5"                                                |
| FA6  | The Keys tab's keys wrap inside the sheet with no sideways scroll, and its Keys menu sends the same messages as the menu.                                                                                       | `floating-controls.svelte.test.ts` "FA6"                                                |
| FA7  | Content taller than the sheet scrolls inside it with a fade at the edge that has more; content that fits has no fade.                                                                                           | `sheet-layout.test.ts` "FA7", `floating-controls.svelte.test.ts` "FA7"                  |
| FA8  | Escape closes the sheet, as do the button and a tap outside.                                                                                                                                                    | `floating-controls.svelte.test.ts` "FA8"                                                |
| FA9  | Show the keyboard focuses the typing area, folds the sheet to the key bar at the top without tabs, and typed text goes to the machine as `text`.                                                                | `floating-controls.svelte.test.ts` "FA9"                                                |
| FA10 | A long press right-clicks in both modes; one that moves or lifts early does not.                                                                                                                                | `touch-gestures.test.ts` "FA10"                                                         |
| FA11 | In trackpad mode a touch within 400 ms of a tap drags with the left button; one later does not.                                                                                                                 | `touch-gestures.test.ts` "FA11"                                                         |
| FA12 | Two fingers moving together at 1× scroll; spreading zooms (1×–5×, about the midpoint, inside the picture); zoomed, two fingers pan; a double two-finger tap resets to 1× without a right click.                 | `zoom.test.ts` "FA12", `touch-gestures.test.ts` "FA12"                                  |
| FA13 | Zoomed, a tap in touch mode clicks the display pixel under the finger, and the picture is drawn enlarged.                                                                                                       | `zoom.test.ts` "FA13", `touch-gestures.test.ts` "FA13", `desktop.svelte.test.ts` "FA13" |
| FA14 | On a touch device a control session shows the gesture hint once; Got it hides it and it stays hidden next time; blocked storage still lets it be dismissed.                                                     | `gesture-hint.test.ts` "FA14", `desktop.svelte.test.ts` "FA14"                          |
| FA15 | A desktop with a mouse sees no hint and its clicks map exactly as before.                                                                                                                                       | `desktop.svelte.test.ts` "FA15"                                                         |

### Security notes

- Zoom is drawn in the browser only; it adds no message type, permission or agent change. Long press and the two-finger tap send the same `pointer` messages a mouse's right button does.
- Watch-only still never sends: the screen's input drops everything when not controlling, and the server and agent drop input from watch-only tickets (SPEC-DESKTOP 7).
- The sheet, its tabs, the hint and the backdrop are separate targets from the screen, so using them never clicks on the remote machine.

### Open questions

None.

### As built (2026-11-12)

- `floating-position.ts` keeps the reader, the snap and `cornerOf`; one zod union reads both the new `{ edge, at }` and the old `{ side, at }` shape. The button rests by CSS (`--along` along its edge), so it is in place before anything is measured.
- `sheet-layout.ts` holds `sheetLayout` and `scrollEdges`. The sheet is one `Panel` (padding none) holding the `TabBar` and a scroll box; the Keys menu and Picture settings are their own Panels inside it. The fades are absolutely placed gradients from `--surface-elevated` to transparent, updated on scroll and by a `ResizeObserver` on the scroll box and its content.
- The tabs reuse no existing component: `TabNav` is for links and `ChipGroup` wraps four labels onto two rows at phone width, so `src/lib/ui/tab-bar.svelte` is a new shared `tablist`.
- Escape is heard on the window while the sheet is open (a key handler on the sheet's `group` is an accessibility warning). The Session tab uses labelled Buttons and a `SegmentedControl` for Touch input instead of icon buttons, since the tab has room for words.
- The phone key bar (`key-bar.svelte`) is a wrapping grid everywhere, also under the screen on the page below 900px, so no key hides off to the side there either.
- `touch-gestures.ts` holds `TouchGestures` (moved from `input.ts`) and `twoFingerIntent`; it takes a timer function, like `KeyFilter`, for the long press and the held-back two-finger right click. The zoom lives in `TouchGestures` and reaches the page through the sink's `zoom`; the page draws it as an inline `transform` on both canvases, inside a new `.picture` box whose unzoomed rectangle is the geometry's `box`. The mouse maps through the same zoom, which a mouse cannot change, so a desktop sees no difference.
- The zoom is clamped to the picture box at the start of every gesture, so a rotated phone never shows past the picture's edge.
- Watch-only sessions get no pinch zoom of their own: their stage keeps the browser's touch handling (`touch-action` is only `none` for control), so the browser's own page zoom applies there.
- The gestures hint is `gesture-hint.svelte` (a Panel headed "Touch gestures" with Tabler icons and Got it) and `gesture-hint.ts` (storage). It shows in the page flow above the screen, and over the screen (under the controls button) in full screen.
- Tests: `floating-position.test.ts`, `sheet-layout.test.ts`, `zoom.test.ts`, `touch-gestures.test.ts` (the touch tests moved here from `input.test.ts`), `gesture-hint.test.ts`, `floating-controls.svelte.test.ts` and `desktop.svelte.test.ts` (FA13 pinches on the real stage, then taps). Not yet tried on a real phone after this change.

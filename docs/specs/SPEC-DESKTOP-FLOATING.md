# SPEC-DESKTOP-FLOATING: A movable controls button in full screen on phones and tablets

**Status:** `IMPLEMENTED (v0.4.11)`, redesigned for phones in "Phone controls, redesigned (option A)" (v0.4.21) · approved 2026-11-10 (Jack: "when you're full screen on mobile you can still send these keys somehow easily … a floating action button that you can move anywhere on the screen that you want … a movable sort of home button that allows you to open up the options and do more in full screen when on mobile. 50% of the time people are going to be providing remote support on their mobile phones so we do need to make this easy.") · **security work:** the controls send input to another person's computer. See "As built" at the end.

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

| #   | Criterion                                                                                                                                                                         | Named test                                                                         |
| :-- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :--------------------------------------------------------------------------------- |
| F1  | In full screen at phone width the floating button shows and the full-screen bar does not; on a desktop-width window with a mouse the bar shows and the button does not.           | `desktop-full-screen.svelte.test.ts` "F1"                                          |
| F2  | Dragging the button moves it, snaps it to the nearer edge at the height it was let go, and sends no input to the machine.                                                         | `floating-controls.svelte.test.ts` "F2", `desktop-full-screen.svelte.test.ts` "F2" |
| F3  | The position is saved per browser and read back; blocked storage or a bad value gives the default (right edge, halfway).                                                          | `floating-position.test.ts` "F3", `floating-controls.svelte.test.ts` "F3"          |
| F4  | A tap opens the sheet; a second tap or a tap outside closes it; a tap outside sends nothing to the machine.                                                                       | `floating-controls.svelte.test.ts` "F4", `desktop-full-screen.svelte.test.ts` "F4" |
| F5  | For a control session the sheet has the actions, phone keys and Keys menu, and its Keys send the same messages as the Keys menu.                                                  | `floating-controls.svelte.test.ts` "F5"                                            |
| F6  | For a watch-only session the sheet has no touch input toggle, keyboard, phone keys or Keys menu.                                                                                  | `floating-controls.svelte.test.ts` "F6"                                            |
| F7  | On a 375×667 phone, portrait and landscape, the open sheet is at most half the screen's height and the page has no horizontal scroll.                                             | `floating-controls.svelte.test.ts` "F7"                                            |
| F8  | Disconnect in the sheet asks first and then ends the session; Leave full screen leaves it.                                                                                        | `desktop-full-screen.svelte.test.ts` "F8"                                          |
| F9  | Show the keyboard focuses the typing area, folds the sheet to the key bar, and typed text goes to the machine as `text`.                                                          | `floating-controls.svelte.test.ts` "F9"                                            |
| F10 | Without the browser's full screen (disabled or refused), Full screen fills the window with the floating button, locks the page's scroll, and Leave full screen restores the page. | `desktop-full-screen.svelte.test.ts` "F10"                                         |

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
- In full screen the test browser's frame grows to the whole headless screen, so `desktop-full-screen.svelte.test.ts` stands in for a phone by making the touch-layout query match (`pretendTouchScreen`); the component tests size the screen to 375×667 themselves.
- iPhone Safari does not support full screen for page elements (only for video), so there the stage fills the window (behaviour 10). `full-screen.svelte.ts` (`FullScreen`) owns both kinds: `on` is the page's one `fullScreen`, `toggle` tries the browser's full screen when `fullscreenEnabled` and falls back to filling on a refusal, `leave` undoes either, and `attach` follows `fullscreenchange`. The stage sits at z-index 20, over the console frame (10) and under the toasts (30); confirmation dialogs open in the top layer above it. Not yet tried on a real iPhone.

## Phone controls, redesigned (option A)

**Status:** `IMPLEMENTED (v0.4.21)` · approved 2026-11-12 (Jack tested the full-screen controls on an Android phone and approved "option A") · **security work:** the gestures send input to another person's computer.

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

| #    | Criterion                                                                                                                                                                                                       | Named test                                                                                          |
| :--- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :-------------------------------------------------------------------------------------------------- |
| FA1  | Released, the button snaps to the nearest of the four edges and keeps its place along it; a drag to the top edge lands it there and is remembered.                                                              | `floating-position.test.ts` "FA1", `floating-controls.svelte.test.ts` "FA1"                         |
| FA2  | A saved `{ side, at }` reads as `{ edge: side, at }`; a bad value or blocked storage gives the right edge, halfway.                                                                                             | `floating-position.test.ts` "FA2"                                                                   |
| FA3  | Portrait gives a bottom sheet; landscape a side panel on the button's edge, or on the side nearer the button when it sits on the top or bottom edge.                                                            | `sheet-layout.test.ts` "FA3"                                                                        |
| FA4  | At 375×667 the open sheet spans the safe width at the bottom and is at most 70% of the height; at 667×375 it is full height, at most 380px and half the width, on the button's side; no horizontal page scroll. | `floating-controls.svelte.test.ts` "FA4"                                                            |
| FA5  | A control session has the tabs Keys, Picture and Session (Screen only with more than one display) and opens on Keys; watch-only has Picture and Session and opens on Session; Session holds the actions.        | `floating-controls.svelte.test.ts` "FA5"                                                            |
| FA6  | The Keys tab's keys wrap inside the sheet with no sideways scroll, and its Keys menu sends the same messages as the menu.                                                                                       | `floating-controls.svelte.test.ts` "FA6"                                                            |
| FA7  | Content taller than the sheet scrolls inside it with a fade at the edge that has more; content that fits has no fade.                                                                                           | `sheet-layout.test.ts` "FA7", `floating-controls.svelte.test.ts` "FA7"                              |
| FA8  | Escape closes the sheet, as do the button and a tap outside.                                                                                                                                                    | `floating-controls.svelte.test.ts` "FA8"                                                            |
| FA9  | Show the keyboard focuses the typing area, folds the sheet to the key bar at the top without tabs, and typed text goes to the machine as `text`.                                                                | `floating-controls.svelte.test.ts` "FA9"                                                            |
| FA10 | A long press right-clicks in both modes; one that moves or lifts early does not.                                                                                                                                | `touch-gestures.test.ts` "FA10"                                                                     |
| FA11 | Replaced by FA16 and FA17 (double tap, edge pan and the fixed cursor, below).                                                                                                                                   | FA16, FA17                                                                                          |
| FA12 | Two fingers moving together at 1× scroll; spreading zooms (1×–5×, about the midpoint, inside the picture); zoomed, two fingers pan; a double two-finger tap resets to 1× without a right click.                 | `zoom.test.ts` "FA12", `touch-gestures.test.ts` "FA12"                                              |
| FA13 | Zoomed, a tap in touch mode clicks the display pixel under the finger, and the picture is drawn enlarged.                                                                                                       | `zoom.test.ts` "FA13", `touch-gestures.test.ts` "FA13", `desktop-full-screen.svelte.test.ts` "FA13" |
| FA14 | On a touch device a control session shows the gesture hint once; Got it hides it and it stays hidden next time; blocked storage still lets it be dismissed.                                                     | `gesture-hint.test.ts` "FA14", `desktop-full-screen.svelte.test.ts` "FA14"                          |
| FA15 | A desktop with a mouse sees no hint and its clicks map exactly as before.                                                                                                                                       | `desktop-full-screen.svelte.test.ts` "FA15"                                                         |

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
- Tests: `floating-position.test.ts`, `sheet-layout.test.ts`, `zoom.test.ts`, `touch-gestures.test.ts` (the touch tests moved here from `input.test.ts`), `gesture-hint.test.ts`, `floating-controls.svelte.test.ts` and `desktop-full-screen.svelte.test.ts` (FA13 pinches on the real stage, then taps). Not yet tried on a real phone after this change.

## Double tap, edge pan and the fixed cursor

**Status:** `IMPLEMENTED (v0.4.22)` · asked for 2026-11-12 after Jack tested option A on an Android phone: "when you tap on the phone twice and then lift your finger that should be considered double tap; if you double tap and hold that should be considered a click and hold so that you can drag a window", "when you zoom in on the screen and then move the cursor towards the edge of the screen the screen should automatically pan to follow the cursor … once you get within a quarter of the edge or so", one touch input control that looks the same on the page and in full screen, and a third "fixed cursor" mode · **security work:** the gestures send input to another person's computer.

### Problem

- In trackpad mode a second touch within 400 ms of a tap pressed the left button at once and held it until the finger lifted. A quick double tap sent press, release, press, and the second release only on lift; the remote machine did not reliably see a double click.
- Zoomed in, moving the pointer towards an edge left it off the visible part of the picture; the person had to stop and pan with two fingers.
- The page showed the touch input as a one-icon toggle, while the full-screen sheet showed a "Control" badge with a mouse-pointer icon beside a "Trackpad / Tap to click" choice: different words and controls for one setting, and the session mode looked like an input mode.
- Some people prefer the cursor fixed in the middle with the picture moving under it, as in other remote tools.

### Behaviour

These replace behaviour 7's "Trackpad drag" bullet and the hint's "Double-tap and drag" line in option A above.

1. **Tap, double tap and double tap-hold** (trackpad and fixed cursor modes; revised after the v0.4.22 phone test, see "Revised after the phone test" below). A tap is a touch that lifts within 300 ms having moved under 10 px. The timeline, with `t` measured from the first tap's lift:
   - The first tap sends nothing yet. If no finger touches down before `t = 250 ms` (`TAP_CLICK_DELAY_MS`), it sends left down and up at the pointer: a single click, 250 ms after the lift.
   - A touch-down before `t = 250 ms` is a second touch. The first tap's click is not sent. The second touch sends nothing yet and starts a 250 ms hold timer (`HOLD_AFTER_TAP_MS`). No long press timer runs for it.
   - **Tap, tap, release:** the second touch lifts before its 250 ms are up, having moved under 10 px. It sends left down, up, down, up at the same pixel, back to back, with no movement between: a double click, and no button is left down. Movement under 10 px during it does not move the pointer.
   - **Tap, touch and hold:** the second touch is still down when its 250 ms are up. The left button goes down where the pointer is, with no click before it, and stays down: moving drags (a window by its title bar, a selection), and lifting the finger sends the button up.
   - **Tap, touch and move:** the second touch moves 10 px or more before its 250 ms are up. The left button goes down at once where the pointer was, again with no click before it; the pointer then moves by the whole movement since touch-down, button held, until the finger lifts.
   - A second finger joining the second touch sends the first tap's click and starts a two-finger gesture. A touch-down at or after `t = 250 ms` is a fresh gesture, after the first tap's click (if its timer is late, the click is sent first). After a double click the next tap is a first tap again.
2. **Double tap in tap-to-click mode.** Taps click at once, as on a touch screen. A second tap within 400 ms (`DOUBLE_TAP_MS`) and within 10 px of the first clicks the same display pixel as the first, so a finger's wobble does not break the double click. A tap followed by a drag there sends a click, then the drag's button down, like a finger on a real touch screen; this mode is left unchanged.
3. **Edge pan while zoomed** (trackpad and tap to click; the trackpad's joystick is revised after the v0.4.22 phone test). The visible area is the part of the page where the zoomed picture shows (the picture box, less letterbox bars). The band is its outer quarter at each edge (`EDGE_BAND` 0.25), measured in page pixels, so it is the same size on the phone screen at every zoom. Inside the band the picture pans towards that edge at up to 900 page pixels a second (`EDGE_PAN_SPEED`), in proportion to how deep into the band the pointer is (none at the band's inner edge, full speed at the screen's edge); the inner area is a dead zone. Edge pan starts only once the finger has moved 10 px in this gesture, so a tap or a long press near an edge never pans. Nothing pans at 1×, after a long press or a two-finger gesture, in fixed cursor mode, or for a mouse; nothing pans past the picture's edges.
   - **Trackpad, as a joystick.** The pointer never leaves the visible area: a finger movement that would take it off the screen stops it at the last display pixel that shows whole. While one finger is down, every animation frame checks where the pointer shows on the page, finger moving or still. In the band the picture pans, and the pointer keeps its place on the phone screen, so on the machine it travels with the view: each frame the remote pointer moves by the display pixels the view moved (with the left button still down during a drag). The picture and pointer move in whole display pixels together, carrying any part-pixel to the next frame, so the drawn cursor never wobbles against the picture. Panning stops when the finger brings the pointer back into the dead zone, when the picture's edge is reached, or when the finger lifts.
   - **Tap to click.** The pointer is under the finger; in the band the picture pans and the pointer follows what is now under the still finger (button still held while dragging).
4. **One touch input choice.** One shared component, `touch-input-choice.svelte` (a `SegmentedControl` labelled "Touch input": Trackpad · Tap to click · Fixed cursor, in that order), is used under the screen on the page (with one line of help for the chosen mode) and in the full-screen sheet's Session tab. It replaces the page's toolbar toggle. The session's mode stays a separate badge ("Control" with a desktop icon, or "View only" with an eye), not a pointer icon.
5. **Remembered.** The choice is saved in `localStorage` (`bmuster.desktop.touchInput`, inside `try`/`catch`), so it is the same in and out of full screen and on the next visit. A bad value or blocked storage gives Trackpad; with storage blocked a change lasts until the page reloads.
6. **Fixed cursor mode.** The remote pointer stays at the centre of the picture box:
   - One finger moves the picture under the centre, one page pixel per page pixel, like a map; the pointer is sent as the display pixel now under the centre (button held while dragging).
   - Tap = click at the pointer; double tap and double tap-hold as in 1; long press = right click; two fingers moving together scroll (wheel) at any zoom; a pinch zooms about the centre, keeping the pointer on its pixel; a double two-finger tap while zoomed goes back to 1× about the centre.
   - The picture may move past its edges, showing the stage's background beyond, as far as it takes to bring its edge (the picture's own edge, not a letterbox bar) under the centre: for a picture that fills the box, half the box each way, at every zoom including 1×. So every pixel, corners included, can sit under the centre. The other modes keep their clamp (never past the picture's edges).
   - At the start of every touch the view is centred on the pointer's current pixel, so switching to this mode, turning the phone or resizing never makes the pointer jump. Nothing else is drawn at the centre: the cursor itself (the local cursor, then the machine's) shows there. (v0.4.22 drew a crosshair there too; it is removed.)
7. **Where the logic lives**, pure and unit tested: the gesture timelines in `touch-gestures.ts`; the edge pan maths in `zoom.ts` (`visibleArea`, `clampToVisible` for the trackpad pointer, `edgeVelocity` for the joystick's speed, `edgePanned` under a finger, `joystickPanned` for the trackpad's step); the fixed cursor maths (`clampFixed`, `centredOn`, `underCentre`, `dragged`) in `fixed-cursor.ts`; the choice's names, help and storage in `touch-input.ts`. `screen-input.ts` only runs the animation frames for the edge pan, from touch-down until the finger lifts.

### Acceptance criteria

FA16 and FA17 replace FA11.

| #    | Criterion                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Named test                                                                                                  |
| :--- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :---------------------------------------------------------------------------------------------------------- |
| FA16 | Trackpad and fixed cursor: a single tap sends one click, once 250 ms have passed since its lift with no second touch; tap, tap and release (the second touch down within 250 ms, lifted within 250 ms, moved under 10 px) sends exactly two clicks at the same pixel and leaves no button down; a two-finger gesture straight after a tap still sends the tap's click. Tap to click: a second tap nearby clicks the same pixel.                                                                                                                                                         | `touch-gestures.test.ts` "FA16"                                                                             |
| FA17 | Trackpad and fixed cursor: tap, then touch and hold past 250 ms sends exactly one left button down, with no click before it, held until the finger lifts, then up; a second touch moved 10 px presses at once and drags by the whole movement; a touch after 250 ms is a fresh gesture after the tap's click.                                                                                                                                                                                                                                                                           | `touch-gestures.test.ts` "FA17"                                                                             |
| FA18 | Zoomed: the trackpad pointer never leaves the visible picture; in the outer quarter of the visible area the picture pans towards that edge at a speed in proportion to the depth, with a dead zone inside; with the finger still the pan goes on, the pointer keeping its place on the screen and its remote position moving with the view (button held during a drag), the same at 1.5×, 2× and 5×; it stops in the dead zone, at the picture's edge, or on lift; nothing pans at 1×, before the finger moves or in fixed cursor mode; in tap to click the pointer follows the finger. | `zoom.test.ts` "FA18", `touch-gestures.test.ts` "FA18"                                                      |
| FA19 | A mouse is unaffected: no edge pan, no double-tap timing, and its clicks map exactly as before.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | `desktop-full-screen.svelte.test.ts` "FA15"                                                                 |
| FA20 | The page and the full-screen sheet show the same "Touch input" choice: Trackpad, Tap to click, Fixed cursor, in that order, each with its help; the session mode is a separate badge.                                                                                                                                                                                                                                                                                                                                                                                                   | `touch-input.test.ts` "FA20", `desktop-full-screen.svelte.test.ts` "FA20"                                   |
| FA21 | The choice is remembered in this browser, in and out of full screen and next time; a bad value or blocked storage gives Trackpad.                                                                                                                                                                                                                                                                                                                                                                                                                                                       | `touch-input.test.ts` "FA21", `desktop-full-screen.svelte.test.ts` "FA21"                                   |
| FA22 | Fixed cursor: a finger moves the picture and the pointer is the display pixel under the centre; tap, double tap and double tap-hold work as in trackpad; nothing but the cursor is drawn at the centre (no crosshair).                                                                                                                                                                                                                                                                                                                                                                  | `fixed-cursor.test.ts` "FA22", `touch-gestures.test.ts` "FA22", `desktop-full-screen.svelte.test.ts` "FA22" |
| FA23 | Fixed cursor: a pinch zooms about the centre keeping the pointer's pixel; two fingers moving together scroll even when zoomed.                                                                                                                                                                                                                                                                                                                                                                                                                                                          | `fixed-cursor.test.ts` "FA23", `touch-gestures.test.ts` "FA23"                                              |
| FA24 | Fixed cursor: the picture moves at most until its edge reaches the centre (half the box each way when it fills the box), so every corner can sit under the centre at 1× and at 3×; the view centres on the pointer at the start of a touch.                                                                                                                                                                                                                                                                                                                                             | `fixed-cursor.test.ts` "FA24", `zoom.test.ts` "FA24", `touch-gestures.test.ts` "FA24"                       |

### Security notes

- No new message type, permission or agent change: double clicks, drags and the fixed cursor send the same `pointer` messages a mouse does, and the edge pan and the fixed cursor's view are drawn in the browser only.
- Watch-only still sends nothing: the screen's input drops everything when not controlling, and the server and agent drop input from watch-only tickets.
- The stored choice is a per-browser convenience with three allowed values, parsed with zod; anything else reads as Trackpad.

### Open questions

None.

### Revised after the phone test

**Status:** `IMPLEMENTED (v0.4.23)` · confirmed with Jack 2026-11-12 after testing v0.4.22 on an Android phone: "double tap and release should be considered a double click; double tap and hold should be considered a click and hold, only releasing when I release the tap"; zoomed in, the cursor must not leave the visible area, and near an edge the view should keep panning like a joystick, even with the finger still, with the cursor travelling with the view; and the fixed cursor's crosshair is not needed, since the cursor already shows there · **security work:** the gestures send input to another person's computer.

Problems in v0.4.22:

- The first tap clicked at once, so tap, then touch and hold sent a click and then a button down: the machine saw a double click and drag (grabbing a title bar maximised the window).
- Zoomed in, the trackpad pointer could go past the edge of the view; the pan ran only while the finger moved; and the remote pointer stayed put while the view panned, so it drifted back out of the band and the pan stopped. At high zoom it rarely started.
- The fixed cursor drew a crosshair at the centre on top of the cursor.

The behaviour above (items 1, 3 and 6, and FA16, FA17, FA18 and FA22) is the revised one. No new message, permission or agent change: the gestures send the same `pointer` messages as before.

As built:

- `TAP_CLICK_DELAY_MS` (250) is both the single tap's delay and the double-tap window in trackpad and fixed cursor modes; `DOUBLE_TAP_MS` (400) is now only tap to click's nearby second tap. A single tap therefore clicks 250 ms after the lift instead of at once.
- `TouchGestures.edgePan` returns true for as long as one finger is down and may pan (zoomed, not fixed cursor, no long press or two-finger gesture), whether or not the picture moved, and `screen-input.ts` starts the frames at touch-down as well as on each move.
- The trackpad's joystick (`joystickPanned`) moves the remote pointer and the picture in whole display pixels together, so the local cursor, drawn at the sent display pixel on a canvas with the picture's zoom, stays still on the screen; the part-pixel is carried in `TouchGestures` from frame to frame and reset at each touch-down.
- A pointer that is off the view when a zoomed trackpad gesture starts is brought to the nearest visible pixel by the first movement.
- Tap to click is unchanged: a tap followed by a drag sends a click, then the drag, as on a real touch screen.
- Not yet tried on a real phone.

### As built

- The hold timer uses the same injected timer as the long press, so the timelines are tested without a browser. `TouchGestures.edgePan(elapsedMs)` returns whether the picture moved; `screen-input.ts` asks for a frame after each touch move and keeps asking while it returns true (each step capped at 50 ms).
- `zoomTransform` now also draws an offset at 1× (the fixed cursor's picture moved past its edge).
- `SegmentedControl` has no icons, so the shared choice uses words only; adding icons would change every caller of the shared control. The "Control" badge's icon changed from the pointer to a desktop.
- The page's touch input choice sits under the screen with its help line (it replaced the toolbar toggle) whenever a control session runs. In the sheet, the Session tab now needs more height: at 667×375 it scrolls inside the sheet with its fade.
- The gestures hint lists "Double-tap: double-click" and "Double-tap and hold: drag".
- Not yet tried on a real phone.

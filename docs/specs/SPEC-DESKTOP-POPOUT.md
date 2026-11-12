# SPEC-DESKTOP-POPOUT: Phones open in full screen; the desktop pops out into its own window

**Status:** `IMPLEMENTED (pending release)` · approved 2026-11-12 (Jack approved both changes: "Phones: assume full screen" and "Desktop: Pop out"; and the third page frame for the pop-out window, with its hygiene rule change) · **security work:** the pop-out window is a new page that attaches to a session that controls another person's computer, and the session moves between browser windows.

## Problem

1. **Phones.** On a phone the desktop tab shows the console's whole bar above the picture (display chips, status, mode switch, touch input, Keys, Picture settings, Full screen, Disconnect) and the key bar and gesture text below it. On a 375px screen that is a crowded page around a small picture, and almost everyone then taps Full screen anyway, where the floating controls (SPEC-DESKTOP-FLOATING, option A) already hold every one of those controls.
2. **Desktop.** On a computer the remote screen sits inside the console, under its sidebar, header and tabs. Someone helping on two monitors, or watching two machines at once, wants the remote screen in a window of its own that they can move, size and put next to another.

## Behaviour

### Phones: assume full screen

1. **Which devices.** A phone is a device whose main pointer is a finger and whose screen is small: `(pointer: coarse) and (max-width: 899px), (pointer: coarse) and (max-height: 599px)` (`phone-layout.ts`, `PHONE_QUERY`). The second half catches a phone on its side, whose width can pass 900px. A tablet (coarse, both sides 600px or more) and any computer with a mouse keep today's page. The floating controls in full screen keep their own, wider test (`(pointer: coarse), (max-width: 899px)`, SPEC-DESKTOP-FLOATING 1).
2. **Connect goes full screen.** On a phone, Connect or Watch only (and so any start of a session) enters full screen in the same tap, so the browser counts it as the person's gesture: the page shows the stage first, then asks for the browser's full screen on it. Where the browser has none or refuses, the stage fills the window exactly as the Full screen button does today (SPEC-DESKTOP-FLOATING 10). Nothing new is said to the person either way; a session that fails to start leaves full screen, as today.
3. **The phone page.** Outside full screen a phone shows only the picture and two buttons, Full screen and Disconnect (Disconnect asks first, as today), plus the notices that say what is happening (the session ended, open in another window, a problem from the agent, a paused picture) and the start panel while no session runs. The display chips, status line, mode switch, touch input choice, Keys, Picture settings, the key bar under the picture and the gesture help text are not on the phone page any more: they are all in the full-screen sheet (Keys, Picture, Screen and Session tabs). The gestures hint shows over the screen in full screen, not on the page.
4. **Computers and tablets** keep today's page, bar and full-screen bar unchanged, plus Pop out (below).

### Desktop: pop out into a window

5. **The button.** While a session runs, the desktop bar has a Pop out tool button (Tabler `IconWindowMaximize`, `aria-label` and `title` "Pop out into a window"). It is on the computer bar only; phones have no windows to pop into.
6. **Opening.** Pop out calls `window.open(url, name, features)`:
   - `url`: `/machines/<id>/desktop/window?sessionId=<session>&mode=<control|watch>&since=<ms>`, the running session's id, mode and start time (camelCase query parameters, §10).
   - `name`: `bmuster-desktop-<machine id>`, one per machine, so several machines can be popped out at once and a second click on the same machine focuses its window instead of opening another.
   - `features`: `popup,width=…,height=…`: the remote picture's aspect ratio (the last frame's size, else the display's, else 16:9) fitted inside 90% of the screen's available area (`popOutSize`, `pop-out.ts`).
   - A blocked pop-up (`window.open` returns `null`) shows an error toast saying the browser blocked the window, and the session stays in the tab.
7. **The session moves, it does not double.** The window adopts the session id into its own per-tab `sessionStorage` (unless it already holds a session of its own, after a reload) and joins it the way a reload does today: a fresh browser ticket for the same signed-in user, then the socket. The relay lets the tab's socket go with close code 4001, as it does for any second window (SPEC-SESSIONS reloads), so only one browser views the session at a time. The server checks the ticket against the person exactly as for a reload; a session of someone else is never issued.
8. **The tab while popped out.** When the session moves to the window it opened, the tab hides the stage and shows a notice "Open in a separate window" with:
   - **Bring it back:** focuses the window while it is open; once it is closed, takes the session back into the tab (one click).
   - **Close window:** closes the window and takes the session back into the tab.
     The tab checks once a second whether the window is still open; when it closes the notice says so ("The separate window was closed") and Bring it back resumes the session here. A session that moved to some other window or tab (not one this tab opened) keeps today's "This session is open in another window or tab" notice with Use it here.
9. **The window page** (`src/routes/(console)/machines/[id]/desktop/window/+page@.svelte`, which resets to the root layout, so it has no console sidebar, header or tabs) shows only the picture, filling the window and fitting it (letterboxed in the stage colour), resizing with the window (the agent is told the new size, as for full screen), with the floating controls button and sheet of full screen (`floating-controls.svelte`, reused). In the window the sheet's exit action is "Close window" instead of "Leave full screen". Its document title is the machine's name.
10. **Keyboard.** The picture takes the keyboard when the window opens, and keys go to the machine as on the tab, Escape included: nothing in the window closes on Escape (only the open sheet does, as in full screen).
11. **The window's own states.** While connecting it shows the same veil and waiting messages as the tab. If the session is taken back by the tab, it shows "This session is back in another window or tab" with Use it here and Close window. If the session has ended, or the window was opened with no session, it shows the start panel (Connect, Watch only) so it can start one of its own, under the same permissions as the tab.
12. **Reload** of the window resumes its session like a reload of the tab (the session id is in the window's `sessionStorage`).
13. **Access.** The window's `load` (`+page.server.ts`) is built by `page.user`; it asks the access service for the person's grants on the machine: no `view` is 404 (a hidden machine looks missing, SPEC-ACCESS A6), and no `desktop-view` is 403. Watch only and control are still decided per session by the server and the agent (SPEC-DESKTOP 7).
14. **A third page frame.** The window renders in `WindowFrame` (`src/lib/shell/window-frame.svelte`): the whole viewport (`100dvh`), padded by the safe-area insets, the stage colour behind, no chrome, and the shared confirmation dialog and toasts. The `page-frame-required` and `page-root-container-forbidden` hygiene rules accept it as a frame beside ShellFrame and PublicPage.
15. Light and dark themes (tokens only); the window's picture area is the stage colour in both.

## Acceptance criteria

| #   | Criterion                                                                                                                                                                                  | Named test                                     |
| :-- | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :--------------------------------------------- |
| PF1 | On a phone a running session's page shows Full screen and Disconnect, and no display chips, status, mode switch, touch input, Keys, Picture settings or key bar.                           | `phone-and-pop-out.svelte.test.ts` "PF1"       |
| PF2 | On a phone Connect enters the browser's full screen on the stage in the same tap, with the floating controls button; Watch only does too.                                                  | `phone-and-pop-out.svelte.test.ts` "PF2"       |
| PF3 | On a phone whose browser refuses full screen, Connect fills the window instead and shows no error.                                                                                         | `phone-and-pop-out.svelte.test.ts` "PF3"       |
| PF4 | A computer with a mouse at desktop width keeps the bar with its tools and Pop out, and Connect does not enter full screen.                                                                 | `phone-and-pop-out.svelte.test.ts` "PF4"       |
| PF5 | The phone query matches a finger on a narrow or short screen and nothing else.                                                                                                             | `pop-out.test.ts` "PF5"                        |
| PO1 | The window size keeps the picture's aspect inside 90% of the screen; the name is per machine; the address carries the session id, mode and start time.                                     | `pop-out.test.ts` "PO1"                        |
| PO2 | Pop out calls `window.open` with the window address, `bmuster-desktop-<id>` and a popup size; a second click while the window is open focuses it instead.                                  | `phone-and-pop-out.svelte.test.ts` "PO2"       |
| PO3 | When the window takes the session (close 4001) the tab hides the stage and shows "Open in a separate window" with Bring it back and Close window; Bring it back focuses the open window.   | `phone-and-pop-out.svelte.test.ts` "PO3"       |
| PO4 | Once the window is closed, Bring it back takes the session back into the tab (a new browser ticket and socket); Close window closes it and does the same.                                  | `phone-and-pop-out.svelte.test.ts` "PO4"       |
| PO5 | A blocked pop-up shows an error toast and the session stays live in the tab.                                                                                                               | `phone-and-pop-out.svelte.test.ts` "PO5"       |
| PO6 | The window page renders in WindowFrame with no console sidebar, header or tabs, titles itself with the machine name, adopts the session from its address and attaches with a fresh ticket. | `desktop-window.svelte.test.ts` "PO6"          |
| PO7 | The window has the floating controls; its sheet offers Close window instead of Leave full screen; keys typed on the picture go to the machine, Escape included.                            | `desktop-window.svelte.test.ts` "PO7"          |
| PO8 | The window's `load` refuses a person without `view` (404) or without `desktop-view` (403), and gives the machine and grants to one with it.                                                | `window-load.test.ts` "PO8"                    |
| PO9 | `page-frame-required` accepts a page in WindowFrame and still fires on a reset page with no frame; `page-root-container-forbidden` stays quiet on WindowFrame's full-height container.     | `tests/unit/hygiene/fixtures/project-rules.ts` |

## Security notes

- The window is a page like the tab: `page.user` signs the person in, and the access service gives the grants (404 without `view`, 403 without `desktop-view`). Nothing in the browser decides access.
- The session id in the window's address is not a credential: the browser ticket endpoint issues a ticket only to the user who owns the session (`issueBrowserTicket(sessionId, user.id)`), and the socket only takes a fresh, single-use ticket. Someone else given the address gets "This session has ended."
- One browser views a session at a time: the relay's existing hand-over (close 4001) moves it, so a pop-out never doubles the viewers or the input paths.
- Watch only stays enforced by the ticket on the server and the agent (SPEC-DESKTOP 7); the window adds no message type and no permission.
- `window.open` is same-origin; no `postMessage` channel is added, and nothing is read from the other window except whether it is closed.

## Open questions

None.

## As built (2026-11-12)

- **Phones.** `pop-out.ts` holds `PHONE_QUERY`; the tab reads it with Svelte's `MediaQuery`. `start()` calls `flushSync()` after starting the session, so the stage is shown before `FullScreen.toggle` asks for full screen inside the tap. On a phone the computer bar stays in the page but is `display: none`, and `phone-toolbar.svelte` shows Full screen and Disconnect while a session runs; the key bar, its help text and the page's gestures hint are not rendered. A refused full screen fills the window (behaviour 2), the same fallback the Full screen button has always had, rather than leaving the phone on the page.
- **The veil and the hint.** Opening straight into full screen showed the gestures hint while the connecting veil was still up, and the veil (z-index 2) covered it. The stage's waiting states moved into `stage-overlay.svelte` (with `connectingTitle` and `isRunning` in `stage-state.ts`, shared with the window), and its veil layer is its own stacking context, so the hint and the controls button stay on top.
- **Pop out.** `pop-out.ts` builds the name, size, features and address and reads the handover back; `pop-out-window.svelte.ts` (`PopOutWindow`) opens or focuses the window and polls `closed` once a second; `popped-out-notice.svelte` is the tab's notice. `SessionLink` gained `handover` (the saved session) and `adopt` (saves one unless the window has its own); `DesktopSession` wraps both with the mode.
- **The window route** is `src/routes/(console)/machines/[id]/desktop/window/+page@.svelte`: the `@` resets it to the root layout, so it shares the desktop folder's components without the console frame, and neither the console's nor the machine's layout `load` runs, so its own `+page.server.ts` repeats their checks (behaviour 13). It reads the handover from `window.location.search` on mount. The picture box is the whole window; a `ResizeObserver` tells the agent the new size 250 ms after the window stops changing size.
- **Floating controls** gained a mandatory `exit: 'full-screen' | 'window'` prop: the tab passes `full-screen` (Leave full screen), the window `window` (Close window, `window.close()`).
- **WindowFrame** (`src/lib/shell/window-frame.svelte`) is `100dvh`, safe-area padded, `--screen-bg`, with `ConfirmDialog` and `ToastHost`. `scripts/hygiene/page-frames.ts` lists it in `BASE_FRAMES`, which covers both `page-frame-required` and `page-root-container-forbidden`; AGENTS.md §4 and the generated rule index name it.
- **Tests:** `pop-out.test.ts` (PF5, PO1), `phone-and-pop-out.svelte.test.ts` (PF1–PF4, PO2–PO5), `window/desktop-window.svelte.test.ts` (PO6, PO7), `window/window-load.test.ts` (PO8) and the two new hygiene fixtures (PO9). `desktop-full-screen.svelte.test.ts`'s phone helper no longer presses Full screen (Connect does it), and FA13 runs on a narrow page with a mouse-pointer device so it can still use the bar's touch input toggle. `FakeSocket` gained `closedByServer(code)`.
- **Not tried on real devices yet:** a real phone (Android Chrome's full screen from Connect, iPhone Safari's window fill), real pop-up windows on a desktop browser (sizing, the per-machine name refocusing, `window.close()` from the sheet), and moving a live session between the tab and the window against a real relay and agent.

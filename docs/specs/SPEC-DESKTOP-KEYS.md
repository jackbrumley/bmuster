# SPEC-DESKTOP-KEYS: A Keys menu for the remote screen

**Status:** `IMPLEMENTED (pending release)` · approved 2026-11-10 (Jack: "We probably will need buttons both on mobile and desktop for things like pressing and submitting Windows keys, potentially submitting Ctrl+Alt+Del, and other keyboard combinations similar to MeshCentral.") · security work (it sends input to another person's computer). See "As built" at the end.

## Problem

The viewer's own system catches some key combinations before the browser sees them: Ctrl+Alt+Del, the Windows key, Alt+Tab, Win+L. Today BMuster offers them in two separate places: the phone key bar (hidden from 900px) and a Ctrl+Alt+Del button that shows only in full screen on Windows machines. A desktop browser outside full screen has no way to send them, and there is no way to send any other combination. MeshCentral and similar tools offer one keys menu everywhere.

## Behaviour

1. **One Keys menu** (`keys-menu.svelte`), opened by a **Keys** tool button (keyboard icon, `aria-label="Keys"`, `aria-pressed` while open) in the desktop tab's bar and in the full-screen bar, at every width. It opens as a block under the bar, like Picture settings; opening one closes the other. It replaces the full-screen bar's Ctrl+Alt+Del button and the phone key bar's Ctrl+Alt+Del key, so Ctrl+Alt+Del has one path (AGENTS.md §10).
2. **Shortcuts,** one shared list per OS family in `keys.ts` (the renamed `key-bar.ts`), labelled for that family (the Windows key is "Win" on Windows, "Super" on Linux, "Cmd" on macOS; Alt is "Option" on macOS):
   - **Windows:** Ctrl+Alt+Del (security screen), Win (Start), Alt+Tab, Alt+F4, Win+L (lock), Win+D (show desktop), Win+R (Run), Ctrl+Shift+Esc (Task Manager), Print Screen.
   - **Linux:** Ctrl+Alt+Del, Super (activities), Alt+Tab, Alt+F4, Super+L (lock), Print Screen.
   - **macOS:** Cmd, Cmd+Tab, Cmd+Q, Ctrl+Cmd+Q (lock). No Ctrl+Alt+Del: it means nothing there.
   - Not listed: Ctrl+Esc (the same as Win, which the agent can send directly) and Ctrl+Alt+T (only some Linux desktops open a terminal with it). Both are one tap away in the custom combination.
3. **Custom combination:** toggles for Ctrl, Alt, Shift and Win, then a key picked from groups (Letters, Digits, F1–F12, Other: Enter, Tab, Esc, Delete, the four arrows) or by **Press a key**: after it is activated, the next non-modifier key pressed on the viewer's keyboard becomes the key, and modifiers held with it switch the toggles on. A preview shows the chord ("Ctrl+Shift+F5"); Send sends it.
4. **Sending:** every shortcut except Ctrl+Alt+Del, and every custom combination, goes as plain `key` messages: modifiers down in the fixed order Ctrl, Alt, Shift, Win, then the key down and up, then the modifiers up in reverse. The agent needs no change. Ctrl+Alt+Del goes as `special ctrl-alt-del`, so the Windows service uses `SendSAS`. After a send the keyboard goes back to the screen.
5. **Ctrl+Alt+Del on Linux** asks first with `confirmAction`: at a text console systemd treats it as a request to restart the machine. On Windows it sends at once (it opens the security screen).
6. **Release all keys** sends `release-all`, for a key left stuck down.
7. **Watch-only viewers never see the menu or its button,** in the bar or in full screen, since they cannot send input. Switching to view only closes it.
8. **Phone key bar** keeps its keys (Esc, Tab, sticky Ctrl and Alt, Win, arrows) and the phone-keyboard toggle; its Win key takes the OS family's label. It builds its key messages with the same function as the menu.
9. Keyboard reachable with visible focus; every icon button has an `aria-label`; works below 768px and on desktop, light and dark, from shared `src/lib/ui` components (Panel, Button, ChipGroup, SectionHeading).

## Acceptance criteria

| #   | Criterion                                                                                                                        | Named test                      |
| :-- | :------------------------------------------------------------------------------------------------------------------------------- | :------------------------------ |
| K1  | A chord sends modifiers down in Ctrl, Alt, Shift, Win order, the key down and up, then the modifiers up in reverse, once each.   | `keys.test.ts` "K1"             |
| K2  | Each OS family gets its own list and labels; only Windows has Win+R and Ctrl+Shift+Esc; macOS has no Ctrl+Alt+Del.               | `keys.test.ts` "K2"             |
| K3  | Every pickable key is one the agent's keymap knows, and Press a key accepts exactly the pickable keys.                           | `keys.test.ts` "K3"             |
| K4  | The menu sends a shortcut's key messages, a custom combination built by toggles and picks or by pressing a key, and release-all. | `keys-menu.svelte.test.ts` "K4" |
| K5  | Ctrl+Alt+Del on Linux asks first and sends nothing when cancelled; on Windows it sends `special ctrl-alt-del` without asking.    | `keys-menu.svelte.test.ts` "K5" |
| K6  | The Keys button shows in the bar and in full screen for control sessions, sends from both, and never shows for watch-only.       | `desktop.svelte.test.ts` "K6"   |
| K7  | The phone key bar sends latched Ctrl and Alt with the next key through the shared chord function.                                | `keys.test.ts` "K7"             |

## Security notes

- The menu only builds input messages a control session can already send by typing; it adds no new message type and no new agent permission. The session ticket's watch-only filter on the server and the agent still drops all input from watch-only viewers (SPEC-DESKTOP 7); hiding the menu is a convenience on top, not the check.
- Ctrl+Alt+Del keeps its existing path (`special` → `SendSAS` in the Windows service). The Linux confirmation guards against restarting a server by accident from a text console.
- Release all keys reuses `release-all`, which the agent already honours.

## Open questions

None.

## As built (2026-11-10)

- `key-bar.ts` is now `keys.ts`: the phone bar's keys, `characterKeys`, the modifiers and their labels, `chordMessages`, `chordLabel`, `shortcutsFor(osFamily)`, the pickable key groups and `pickableKey(code)`.
- `keys-menu.svelte` is a `Panel` headed "Keys" with three parts: the shortcuts as `Button`s, the custom combination (modifier toggles as `chip` raw buttons, `ChipGroup`s for the key group and the key, a `key` raw button for Press a key) and Release all keys.
- The page keeps one `open` state (`none`, `settings`, `keys`) for both blocks, so they never show together; in full screen the menu shows under the full-screen bar, which stays visible while it is open.
- The `special` names `win`, `alt-tab` and `print-screen` are no longer sent by the browser (they go as plain keys). They stay in the protocol and the agent, since removing them is a protocol change and costs nothing to keep.
- Tests: `keys.test.ts` (K1, K2, K3, K7), `keys-menu.svelte.test.ts` (K4, K5, and macOS without Ctrl+Alt+Del), `desktop.svelte.test.ts` (K6, replacing the full-screen-only Ctrl+Alt+Del test). Not yet checked on a real Windows machine: Windows may refuse an injected Win+L (it guards the lock shortcut); if so, Win+L needs its own `special` that calls `LockWorkStation` in the user's session.

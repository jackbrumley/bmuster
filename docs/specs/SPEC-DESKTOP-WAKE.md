# SPEC-DESKTOP-WAKE: Wake the screen on connect and keep the machine awake while connected

**Status:** `IMPLEMENTED (pending release)` · approved 2026-11-10 (Jack: "surely we should be able to wake it up and remote control it … the screen should sort of come on by itself when we connect and stay awake whilst we're connected"; and "make sure it doesn't go to sleep again either whilst you're connected so that you don't wind up in a spot where you can't do anything") · **security work:** the agent injects input on someone's machine without a viewer asking for each event, and holds off sleep. Native tests on the Fedora laptop and on Windows are pending; see As built.

## Problem

A Fedora 44 GNOME Wayland laptop (agent 0.4.6, running as root) was powered up, but a control desktop session sat on "The screen is off" with backend `none` and no frames. GNOME had blanked the panel on idle (DPMS off), so the KMS capture path saw no lit CRTC and never opened the screen. Without an open screen the session had no input device either, so the viewer could not move the mouse to wake it. The viewer should not have to wait for someone at the machine.

Once connected, the same idle timers blank the screen again, lock the session, or put the whole machine to sleep, which drops the viewer and leaves them unable to do anything.

## Behaviour

1. **Wake on connect (control sessions).** When a control session's look at the screen says the display is dark (the KMS path finds no lit display), the agent sends a harmless wake input so the compositor turns the screen on; the next look finds the lit display and opens it as usual. While the screen stays dark it sends the wake input again at most once every 3 s.
2. **What the viewer sees.** While waking, the reason reads "The screen is off; waking it". After 10 s still dark it reads "The screen stays off. If this is a laptop, its lid may be closed." A closed lid with no other screen cannot be woken by input: the compositor keeps the internal panel off whatever input arrives.
3. **Watch-only sessions never inject anything.** They have no wake device and keep the plain "The screen is off" reason.
4. **Stay awake while connected.** While a control session has the screen open, the agent sends the wake input whenever nothing has reached the machine for 30 s (shorter than any common idle timeout; GNOME's shortest blank delay is 1 minute). The first one goes 2 s after the screen opens, so a screen that is lit but about to blank (or an X11 screen whose framebuffer still captures while DPMS is off) is woken at once. Real viewer input (pointer, wheel, keys, text, special keys) resets the timer. It stops when the session ends.
5. **The wake input.**
   - **Linux:** a dedicated uinput device, "BMuster wake", with only `REL_X`, `REL_Y` and `BTN_LEFT` (libinput needs the button to class it as a pointer; it is never pressed). A nudge is two frames: `REL_X +1`, then `REL_X −1`. Relative motion is never filtered by the kernel (unlike an absolute move to the same place, which the input core drops as a repeat), every idle monitor (Mutter, KWin, Xorg) counts it as activity, and the pointer ends where it started (at most a pixel off under pointer acceleration). The device is shared by every control session and kept for the session, never made per nudge, because libinput takes a moment to start listening to a new device.
   - **Windows:** `SendInput` with a relative mouse move of 0, 0, which resets the input idle timer without moving the pointer. A nudge is also sent when capture fails in a control session (a display that went off can make Desktop Duplication fail).
6. **Windows display.** While a control desktop session runs, the desktop helper holds `SetThreadExecutionState(ES_CONTINUOUS | ES_DISPLAY_REQUIRED | ES_SYSTEM_REQUIRED)` on a thread of its own, and clears it with `ES_CONTINUOUS` on that thread when the session ends. `ES_DISPLAY_REQUIRED` forces the display on and stops it turning off on idle.
7. **No idle sleep while any session is open.** While any remote session (desktop control or watch, terminal, exec or files) is open on the machine, the agent holds off automatic (idle) sleep, whatever the per-machine Stay awake setting says:
   - **Linux:** a logind inhibitor lock, what `sleep:idle`, mode `block`, who "BMuster", why "A BMuster remote session is open", separate from the Stay awake lock.
   - **Windows:** `SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED)` on a dedicated thread of the service.
   - It is a count: taken when the first session opens and released when the last one ends. Each session holds a guard that is dropped when its thread ends, so a session that fails or panics never leaks the lock.
   - Like Stay awake, it never blocks a sleep or shutdown a person asks for (lid, power button, Sleep or Shut down from the menu): only idle sleep.
8. **Logs and timeline.** The agent logs at info when it starts waking a dark screen and when the screen comes on (once per off-to-on), and when the session sleep hold is taken and released. The session timeline records each new reason through its existing `screen-state` step ("unavailable: The screen is off; waking it", then the screen's state).

## Security

This is security work. The agent now sends input to the machine that no viewer typed:

- Only control sessions, whose ticket already carries the control permission, ever get a wake device. Watch-only sessions never create one and never inject.
- The wake device can only move the pointer by relative steps: it has no keys, no absolute axes and its one button is never pressed. A nudge moves the pointer one unit and back, so it cannot click, type or unlock anything; at a lock screen it only shows the lock screen.
- Nudges happen only while a control session is open, at most once every 3 s while dark and once every 30 s while open.
- Holding off idle sleep is limited to `sleep:idle` / `ES_SYSTEM_REQUIRED` and is released when the last session ends or the agent stops. No check was weakened.

## Acceptance criteria

| #   | Criterion                                                                                                                          | Named test                                                                 |
| :-- | :--------------------------------------------------------------------------------------------------------------------------------- | :------------------------------------------------------------------------- |
| W1  | A control session whose look is dark sends a wake nudge, says "waking it", and opens the screen once the look is lit.              | Rust `session::following::tests::wake_nudges_a_dark_screen_in_control`     |
| W2  | A watch-only session never builds a wake device and never nudges; its reason stays "The screen is off".                            | Rust `session::following::tests::wake_never_touches_a_watch_session`       |
| W3  | While dark, nudges are at most once every 3 s; after 10 s the reason says the lid may be closed; lit again resets it.              | Rust `session::wake::tests::wake_is_rate_limited_and_says_the_lid`         |
| W4  | While the screen is open, a nudge goes 2 s after opening and then after 30 s without input; viewer input resets the timer.         | Rust `session::wake::tests::keep_awake_cadence_and_viewer_input`           |
| W5  | Through the session: keep-awake nudges while open, none while the viewer is busy, none after the session ends.                     | Rust `session::following::tests::keep_awake_while_the_screen_is_open`      |
| W6  | The wake device has only `REL_X`, `REL_Y` and `BTN_LEFT`; a nudge writes `REL_X +1` then `REL_X −1`, as two frames.                | Rust `input::uinput::tests::wake_device_capabilities_and_events`           |
| W7  | Windows display hold: `ES_CONTINUOUS \| ES_DISPLAY_REQUIRED \| ES_SYSTEM_REQUIRED` set and cleared on its own thread.              | Rust `power::windows::tests::display_hold` (runs on Linux; Windows linted) |
| W8  | The session sleep hold is taken on the first open session, kept while any is open, released on the last end; a failure is retried. | Rust `power::sessions::tests::remote_sessions_hold_off_idle_sleep`         |
| W9  | The session guard counts overlapping sessions and lets go when dropped, even by a panicking thread.                                | Rust `power::sessions::tests::session_guards_count_and_never_leak`         |
| W10 | Linux session lock: Inhibit called with `sleep:idle`, "BMuster", "A BMuster remote session is open", `block` (fake bus).           | Rust `power::linux::tests::session_inhibitor_call`                         |

## Schema and routes

None. No server, protocol or browser change: the new reasons travel in the existing `state` message.

## Open questions

- **Report line.** The machine report's `power.keepAwake` is a closed enum (`off`, `active`, `waiting-for-mains`) that the server parses strictly, so a new value such as `session` from a newer agent would make an older server reject the whole inventory. The session hold is logged only; showing it needs a server change first.

## As built (pending release)

| #   | Status                                      | Test                                                                   |
| :-- | :------------------------------------------ | :--------------------------------------------------------------------- |
| W1  | Passing                                     | Rust `session::following::tests::wake_nudges_a_dark_screen_in_control` |
| W2  | Passing                                     | Rust `session::following::tests::wake_never_touches_a_watch_session`   |
| W3  | Passing                                     | Rust `session::wake::tests::wake_is_rate_limited_and_says_the_lid`     |
| W4  | Passing                                     | Rust `session::wake::tests::keep_awake_cadence_and_viewer_input`       |
| W5  | Passing                                     | Rust `session::following::tests::keep_awake_while_the_screen_is_open`  |
| W6  | Passing                                     | Rust `input::uinput::tests::wake_device_capabilities_and_events`       |
| W7  | Passing on Linux; Windows only lint-checked | Rust `power::windows::tests::display_hold`                             |
| W8  | Passing                                     | Rust `power::sessions::tests::remote_sessions_hold_off_idle_sleep`     |
| W9  | Passing                                     | Rust `power::sessions::tests::session_guards_count_and_never_leak`     |
| W10 | Passing                                     | Rust `power::linux::tests::session_inhibitor_call`                     |

- **Dark looks.** `Look` gained `dark: bool`. Only the KMS path's "no lit display" look (`kms-off:<session>`) is dark; every other look, including Windows, is not. The session replaces the dark look's reason with the waking reasons only when it has a wake device (a control session).
- **Wake device.** `ScreenWatch::waker()` gives the session its wake device once, when a control session starts (the Linux watch and the agent's Wayland watch give the shared "BMuster wake" device; Windows gives the `SendInput` waker; the default is none). A device that cannot be made is logged and the session carries on without waking. A failed nudge is logged once per run of failures and never ends the session.
- **Windows.** The display hold reuses the Stay awake execution-state thread with different flags, taken in `sessions::desktop::run` for a control session (the helper in the console session runs it). Nothing has run on Windows itself; checked with `cargo clippy --target x86_64-pc-windows-gnu --all-targets -- -D warnings`.
- **Session sleep hold.** Each session thread (in `sessions::Sessions::open`, so terminal, exec, files and desktop alike; on Windows the service's thread waits for the helper's desktop session) holds a `power::sessions::SessionHold` for its whole run. The count lives in `power::sessions`; the stay-awake thread takes or releases its second lock on every change and retries a failure every 30 s. Release builds abort on a panic, which ends the agent and so releases logind's lock with it; the guard covers unwinding builds and every ordinary error path. Not shown in the machine report (see Open questions).
- **Rate limit across spells.** The 3 s limit counts from the last nudge of any kind, so a screen that goes dark within 3 s of a nudge waits out the rest of those 3 s.
- **Not yet tried on the laptop.** Whether Mutter wakes the panel from DPMS off on a relative nudge from a uinput device is expected (Mutter's idle monitor counts every libinput event) but untested on the reporting machine.

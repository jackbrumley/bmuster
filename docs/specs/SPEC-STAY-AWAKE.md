# SPEC-STAY-AWAKE: Keep a machine awake while it is on mains power

**Status:** `IMPLEMENTED (v0.4.5)` · approved 2026-11-09 (Jack: "on each machine you can tell it when on AC power don't go to sleep … want that same capability here") · security work. Native tests (an installed Linux agent as root, any Windows run) are pending; see As built.

## Problem

A machine that goes to sleep drops off BMuster: no remote desktop, terminal or files until someone wakes it. Other remote-access tools offer a per-machine "do not sleep while on AC power" switch; BMuster needs the same. A laptop on battery should still sleep normally.

## Behaviour

1. **Setting.** Each machine has **Stay awake on mains power** (on for machines enrolled from 0.4.20, off for machines enrolled before; the column default stays 0 and enrolment sets it) on its Manage page, changed by admins only and audited (`machine-power-policy-changed`, with old and new value). The server sends the policy to the agent on the live socket (`power-policy { keepAwakeOnAc }`) when it changes and on every connect; the agent keeps the last policy in its data folder so it applies after a restart before the server is reachable.
2. **On the machine.** While the policy is on **and** the machine is on mains power (or has no battery, like a desktop), the agent prevents automatic sleep; when the power source becomes battery, or the policy is turned off, it stops preventing it at once. It checks the power source every 30 s and on power-change events where available.
   - **Linux:** hold a logind inhibitor lock (`org.freedesktop.login1.Manager.Inhibit`, what `sleep:idle`, mode `block`, who "BMuster", why "Stay awake on mains power is on for this machine") and release it by closing its file descriptor. Mains power is read from `/sys/class/power_supply/*/type` = `Mains` with `online` = 1; no battery present counts as mains.
   - **Windows:** `SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED)` on a dedicated thread of the service while active, and `ES_CONTINUOUS` to release. Mains power from `GetSystemPowerStatus` (`ACLineStatus = 1`, or no battery).
   - **macOS:** no agent yet; nothing built.
3. It never blocks a sleep or shutdown a person asks for (lid close, power button, Sleep or Shut down from the menu): only idle sleep. The screen may still turn off.
4. **Report.** The machine report gains `power`: `{ source: 'mains' | 'battery' | 'unknown', batteryPercent | null, keepAwake: 'off' | 'active' | 'waiting-for-mains', inhibitor: 'held' | 'none' | 'failed' with reason }`. Manage shows it beside the switch ("On mains power: staying awake", "On battery: sleeping normally until mains returns"). A failure to take the inhibitor is logged and shown, never silent.
5. A self-check `stay-awake` (SPEC-DIAGNOSTICS) takes and releases the inhibitor once without changing anything else.

## Security

This changes the machine's behaviour, so it is admin-only, audited and visible on the machine report. The agent accepts only a boolean from the server. The inhibitor is released when the agent stops.

## Acceptance criteria

| #   | Criterion                                                                                                               | Named test                                                         |
| :-- | :---------------------------------------------------------------------------------------------------------------------- | :----------------------------------------------------------------- |
| P1  | Admins change the policy; members are refused; changes are audited and sent to the live agent and on reconnect.         | `power-policy.test.ts`                                             |
| P2  | The agent stores the policy and applies it after a restart before connecting.                                           | Rust `power::tests::policy_persists`                               |
| P3  | Power source detection from fixture `/sys/class/power_supply` trees: mains, battery, both, none.                        | Rust `power::linux::tests::source_from_sysfs`                      |
| P4  | The keep-awake state machine holds the inhibitor only while policy on and on mains, and releases on battery or off.     | Rust `power::tests::hold_only_on_mains`                            |
| P5  | Linux inhibitor: Inhibit called with the fixed what/who/why/mode; releasing closes the descriptor; failure is reported. | Rust `power::linux::tests::inhibitor_call` (fake bus)              |
| P6  | Windows: execution state set and cleared on the dedicated thread.                                                       | Rust `power::windows::tests::execution_state` (Windows CI compile) |
| P7  | Manage shows the switch and the report's power line; phone width has no overflow.                                       | `power-policy.svelte.test.ts`                                      |
| P8  | The `stay-awake` self-check takes and releases the inhibitor.                                                           | Rust `checks::tests::stay_awake_check`                             |
| S13 | A newly enrolled machine starts with Stay awake on mains power on (pending release; Jack, 2026-11-12).                  | `enrolment.test.ts` "S13: a newly enrolled machine stays awake…"   |

## Schema and routes

- `machines.keep_awake_on_ac` (integer boolean, not null, default 0): generated, additive migration.
- `PUT /api/machines/[id]/power-policy` (admin, origin-checked, audited).
- Live socket `power-policy`; inventory `power` (older agents: `unreported`).

## As built (pending release)

Every acceptance criterion has a passing test with the name the table gives. P6's test runs on every platform (only the two Win32 calls are Windows code); nothing has run on Windows itself. Where the build differs from the text above, or adds to it:

| #   | Status                                      | Test                                                                                          |
| :-- | :------------------------------------------ | :-------------------------------------------------------------------------------------------- |
| P1  | Passing                                     | `power-policy.test.ts` (service, endpoint 401/403/400/404/200, origin check, older inventory) |
| P2  | Passing                                     | Rust `power::tests::policy_persists`                                                          |
| P3  | Passing                                     | Rust `power::linux::tests::source_from_sysfs`                                                 |
| P4  | Passing                                     | Rust `power::tests::hold_only_on_mains`                                                       |
| P5  | Passing; real logind tried                  | Rust `power::linux::tests::inhibitor_call`                                                    |
| P6  | Passing on Linux; Windows only lint-checked | Rust `power::windows::tests::execution_state`                                                 |
| P7  | Passing                                     | `power-policy.svelte.test.ts`                                                                 |
| P8  | Passing                                     | Rust `checks::tests::stay_awake_check`                                                        |

- **Server.** `machines.keep_awake_on_ac` comes from the generated migration `0015_keep_awake_on_ac.sql` (one `ALTER TABLE … ADD`). `PUT /api/machines/[id]/power-policy` takes exactly `{ keepAwakeOnAc: boolean }` (a strict schema: anything else is 400), answers `{ keepAwakeOnAc, delivered }`, and 404s an unknown or removed machine. Only a real change is audited (`machine-power-policy-changed`, detail `from` and `to` as `on`/`off`); the same value again is sent to the agent again but not audited. The Activity page labels it "Changed Stay awake on mains power" with a plug icon; the audit readers need nothing else. The browser API client gained `PUT`.
- **Socket and report.** `power-policy { keepAwakeOnAc }` goes out on every connect, after the pin and verbose messages. The report travels in the hashed inventory as `power: { kind: 'unreported' } | { kind: 'reported', source, batteryPercent, keepAwake, inhibitor }`; older agents leave it out and read as `unreported`. The battery percentage is rounded to 5 so ordinary drain does not resend the whole inventory every check-in. A policy that changes makes the agent check in at once, so Manage shows the new state within seconds; until then the line says the agent applies it at its next check-in.
- **Agent.** A `stay-awake` thread in the worker applies the saved policy (`<data>/power-policy.json`, written private and atomically; a missing or damaged file is off) before the socket connects, reads the source every 30 s and applies a new policy at once. It holds nothing when the source is `unknown` (shown as waiting for mains). On stop it releases the lock and the thread ends. **No power-change events:** Linux would need a UPower or udev subscription, and on Windows the service's power events reach the launcher's process, not the worker's, so the agent notices a plug or unplug within 30 s (idle sleep timers are minutes).
- **Linux source.** Mains when any `Mains` supply has `online` 1, or when there is no system battery (no folder, no supplies, only `scope = Device` batteries such as a mouse, or `present` 0). The percentage is the average of the system batteries' `capacity`. A USB-C charger (`type` `USB…` with `online` 1 and not `scope = Device`) also counts as mains, since many laptops list no `Mains` supply.
- **Linux inhibitor.** zbus `=5.19.0` is now a direct Linux dependency with the `tokio` feature only, the same build ashpd and ksni already pulled in (Cargo.lock gains one edge, no new crates). One short system-bus connection per take on a current-thread runtime, with a 5-second limit; the lock lives in the returned descriptor. **The unit sandbox is unchanged:** the agent is root, `RestrictAddressFamilies` already allows `AF_UNIX`, and `/run/dbus/system_bus_socket` stays reachable under `ProtectSystem=strict` (a read-only mount still allows connecting, as the existing `busctl` checks show). Tried by hand from a test as a desktop user on Linux Mint (Cinnamon): `systemd-inhibit --list` showed `BMuster … sleep:idle … Stay awake on mains power is on for this machine … block` while held and nothing after release. Not yet tried as the installed root service.
- **What it blocks (behaviour 3).** logind's default `LidSwitchIgnoreInhibited=yes` keeps lid close working, and the power key's default action (power off) is not a sleep. A Suspend chosen from a desktop menu is a request to logind that a `block` sleep lock refuses unless the caller may ignore inhibitors (polkit `org.freedesktop.login1.suspend-ignore-inhibit`, allowed for the active local user by default); desktops usually show who is inhibiting and offer to suspend anyway. This needs a native check on the Fedora laptop.
- **Windows.** Each hold is a thread of its own (`stay-awake-hold`): `ES_CONTINUOUS | ES_SYSTEM_REQUIRED`, then `ES_CONTINUOUS` on the same thread when the hold is dropped. Mains when `ACLineStatus` is 1 or `BatteryFlag` says no system battery; a line status of 255 with a battery is `unknown`. Checked with `cargo clippy --target x86_64-pc-windows-gnu --all-targets -- -D warnings` (C dependencies stubbed, nothing linked); the pure parts run on Linux.
- **Self-check.** `stay-awake` is the last check on Linux and Windows. It takes a second, separate inhibitor and releases it at once (logind and Windows both allow several), so it never touches the keeper's own lock.
- **Manage.** A **Power** panel between Agent and Local page: an On/Off control labelled "Stay awake on mains power", what it does in one paragraph, and the report's line (warning colour for an old agent or unknown source, danger colour with the reason when the lock failed).
- **Decided 2026-11-09:** a USB-C charger counts as mains (the coordinator's call while Jack was away; the build agent recommended it).

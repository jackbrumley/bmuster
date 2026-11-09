# SPEC-STAY-AWAKE: Keep a machine awake while it is on mains power

**Status:** `APPROVED` 2026-11-09 (Jack: "on each machine you can tell it when on AC power don't go to sleep … want that same capability here").

## Problem

A machine that goes to sleep drops off BMuster: no remote desktop, terminal or files until someone wakes it. Other remote-access tools offer a per-machine "do not sleep while on AC power" switch; BMuster needs the same. A laptop on battery should still sleep normally.

## Behaviour

1. **Setting.** Each machine has **Stay awake on mains power** (off by default) on its Manage page, changed by admins only and audited (`machine-power-policy-changed`, with old and new value). The server sends the policy to the agent on the live socket (`power-policy { keepAwakeOnAc }`) when it changes and on every connect; the agent keeps the last policy in its data folder so it applies after a restart before the server is reachable.
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

## Schema and routes

- `machines.keep_awake_on_ac` (integer boolean, not null, default 0): generated, additive migration.
- `PUT /api/machines/[id]/power-policy` (admin, origin-checked, audited).
- Live socket `power-policy`; inventory `power` (older agents: `unreported`).

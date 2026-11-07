# SPEC-AGENT-UPDATES: Keeping every agent up to date

**Status:** `IMPLEMENTED` (U1–U14 built 2026-11-07, see section 7; version bump and changelog left for the release step) · approved 2026-11-07 · **Date:** 2026-11-07

## 1. Approach

Both, in this order: make an update so safe that nobody has to think about it, **and** give admins a small set of controls for the day something goes wrong. The default is automatic.

## 2. Making an update safe

- **Launcher and worker.** The installed service is a small launcher that runs the worker (the real agent). An update replaces only the worker; the launcher never replaces itself, so a bad release cannot break the thing that rolls it back.
- **Signed releases.** Every build is signed with a release key kept off the server. The agent installs only builds signed by a key it trusts. A compromised BMuster server can therefore not push its own code to every machine.
  - Official builds are signed by the BMuster project key, built into the agent.
  - Self-builders can add their own release key at install time.
- **Health check, then commit.** After switching, the new worker must check in successfully within 2 minutes; otherwise the launcher switches back to the previous version and reports _rolled back_ with the reason.
- **Two versions on disk.** `current` and `previous`; an update downloads to a third folder, checks size, SHA-256 and signature, then switches.
- **Same version as the server.** A BMuster server image carries the agent builds of its own version. Updating the server makes the new agent available; the update policy decides when machines take it.

## 3. Controls

- **Update policy (server setting):**
  - _Automatic_ (default): staged roll-out, below.
  - _Manual_: machines update only when an admin says so.
- **Staged roll-out.** A new version goes first to the machines in the built-in _Early updates_ machine group (if it has any), then to 10% of the rest after 1 hour without a rollback, then to all after another hour. One rollback anywhere pauses the roll-out and tells the admins.
- **Pause / resume** the roll-out from the Updates page.
- **Pin a machine** to its current version (for a fussy machine); it shows as _pinned_ until unpinned.
- **Update now** on one machine, a selection, or everything (Manual mode, or to jump the queue).

## 4. Console

- **Updates page:** the version each machine runs, the version on offer, roll-out progress, failures and rollbacks, Pause and Update buttons.
- **Machine Overview → Agent panel:** version, update state (_up to date_, _updating_, _rolled back: reason_, _pinned_).
- Every update, rollback, pin and policy change is audited.

## 5. Decisions (2026-11-07)

1. **Default policy:** Automatic with the staged roll-out, plus Pause, Pin and Update now. Manual is a setting.

## 6. Open questions

1. Should the project publish signed builds on GitHub Releases for servers to fetch, or only inside the server image?

## 7. As built (2026-11-07)

**Security note.** This is agent-update work, so it is security work (AGENTS.md §11). The server never holds a release key and never signs; it can only offer builds that a key the agent trusts has signed. Downloads use the agent's existing connection and certificate check (trust store, or the pinned key in local network mode, following pin rollover). Nothing is weakened for updates.

### Acceptance criteria

| #   | Criterion                                                                                                                                                                                                                                                                                                              | Test                                                                                                                                                                                     |
| :-- | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| U1  | The service runs `bmuster-agent launch`; the launcher runs `versions/current/bmuster-agent run --launched` and never replaces itself. A fresh install seeds `current` from the launcher.                                                                                                                               | `launcher::tests::an_interrupted_switch_is_finished_and_a_missing_current_seeded`, `service_linux::tests::unit_runs_the_installed_binary_and_spares_revoked_exits`, manual (scratch rig) |
| U2  | A build is signed over `BMUSTER-RELEASE-1\n<version>\n<target>\n<size>\n<sha256>`; the TypeScript signer and the Rust verifier agree.                                                                                                                                                                                  | `release_vector` (protocol), `release-signing.test.ts`                                                                                                                                   |
| U3  | The agent refuses a build that is not newer, not for its target, the wrong size or SHA-256, unsigned, or signed by an untrusted key; the launcher checks again with its own keys before switching.                                                                                                                     | `updates::tests::*`, `launcher::tests::the_launcher_refuses_a_build_signed_by_another_key`, manual                                                                                       |
| U4  | Production agents trust only the project key (`release-key.pub`); a build trusts one more key only when `BMUSTER_EXTRA_RELEASE_KEY` is set at build time.                                                                                                                                                              | `updates::tests::this_build_trusts_its_release_key_and_no_unknown_one`, build.rs                                                                                                         |
| U5  | The new worker must check in within 120 s; if it exits first or misses the deadline, the launcher restores `previous` and records "rolled back" with the reason.                                                                                                                                                       | `launcher::tests::*rolled_back*`, `a_marker_from_another_version_does_not_count`, manual                                                                                                 |
| U6  | `current` and `previous` on disk; a download goes to `incoming` and is checked before the switch; `switch.json` is the commit point, so a crash part-way is finished or undone at the next start.                                                                                                                      | `launcher::tests::*`                                                                                                                                                                     |
| U7  | Every check-in reports `update` (`no-launcher`, or `launcher` with the last event); the reply carries `update` (`none` or `offer`). Older agents and servers keep working (defaults on both sides).                                                                                                                    | `update_shapes_match_the_server`, `agent-updates.test.ts`                                                                                                                                |
| U8  | Staged roll-out: the built-in Early updates machine group (SPEC-ACCESS A11, found by `built_in = 'early'`, never by name), then 10% of the rest after an hour, then all after another; while the group is empty it starts at 10%. The Updates page links to the group with its machine count ("0 machines — add one"). | `agent-updates.test.ts` (domain and service), `early-updates-migration.test.ts`, `updates-page.svelte.test.ts`                                                                           |
| U9  | One rollback or refusal pauses that version's roll-out, is audited, and admins see it on Machines and Updates.                                                                                                                                                                                                         | `agent-updates.test.ts`, `machines-page.svelte.test.ts`, `updates-page.svelte.test.ts`                                                                                                   |
| U10 | Pause and resume, pin and unpin, Update now (one, a selection, all) are admin-only and audited; Update now jumps a pause, Manual mode and an earlier failure, never a pin; it asks connected agents to check in at once.                                                                                               | `agent-updates.test.ts`, `agent-update.svelte.test.ts`, `updates-page.svelte.test.ts`                                                                                                    |
| U11 | Setting `agentUpdatePolicy`: Automatic (default) or Manual.                                                                                                                                                                                                                                                            | `settings.test.ts`                                                                                                                                                                       |
| U12 | Badges on the machine card, table row and machine header: Update available, Updating, Rolled back, Update refused, Pinned; none when up to date.                                                                                                                                                                       | `agent-updates.test.ts` (domain), `machines-page.svelte.test.ts`                                                                                                                         |
| U13 | Manage → Agent panel: version, state, Update now, Pin; an agent from before the launcher is told plainly to reinstall once. The Local page panel's "too old" state is a warning, not a faint line.                                                                                                                     | `agent-update.svelte.test.ts`, `local-page.svelte.test.ts`                                                                                                                               |
| U14 | `npm run agent:release-local` gives every build its own version `<cargo>-dev.<UTC yyyymmddhhmmss>` and signs it with a development key.                                                                                                                                                                                | manual (scratch rig)                                                                                                                                                                     |

### How it differs from the design

- **Early updates is built in** (added after U1–U14). At first the roll-out looked for a machine group named "Early updates", which existed only if someone made it. Migration `0010` now makes it a built-in group like All machines (or adopts an existing group of that name, keeping its machines and rules), and the roll-out finds it by `built_in`. It cannot be renamed or deleted; its machines are added and taken out as usual.
- **One binary.** The launcher is `bmuster-agent launch`, the same program as the worker, so every target still ships one file and the install scripts are unchanged. The launcher's own code is whatever was installed; it is only replaced by reinstalling.
- **Versions live in the data folder** (`/var/lib/bmuster/versions`, `C:\ProgramData\BMuster\versions`), which only root or SYSTEM can write and which the systemd sandbox already allows (`ReadWritePaths=/var/lib/bmuster`).
- **Self-builders' keys** are given at build time (`BMUSTER_EXTRA_RELEASE_KEY`), not at install time.
- **Signatures** sit beside each build as `bmuster-agent[.exe].sig` (base64). The server offers only signed builds as updates; unsigned builds still install from Add machine.
- **Telling the admins** is the audit entry plus a notice on Machines and Updates. An email notification for failed updates (SPEC-EMAIL rules) is not built yet.

### Moving an agent from before the launcher

An agent installed before this change runs `bmuster-agent run` directly and cannot update itself; the console says so (Update available, and a warning on the Agent panel). Reinstall it once from the machine's Manage tab → Reinstall agent: the new install keeps the machine's entry and history, and from then on it updates itself.

# SPEC-AGENT-UPDATES: Keeping every agent up to date

**Status:** `APPROVED` (design, 2026-11-07; not built) · **Date:** 2026-11-07

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
- **Staged roll-out.** A new version goes first to the machines in the _Early updates_ machine group (if any), then to 10% of the rest after 1 hour without a rollback, then to all after another hour. One rollback anywhere pauses the roll-out and tells the admins.
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

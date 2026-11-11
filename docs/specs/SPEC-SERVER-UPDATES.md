# SPEC-SERVER-UPDATES: Whole-install updates by a root updater, for server and agent

**Status:** `IMPLEMENTED (v0.4.1)` 2026-11-09 · approved 2026-11-09 (Jack: "go", then "build everything") · second version. Replaces the v0.3.0–v0.3.3 application-slot design (see "Version 1" at the end). See "As built" for what was tested natively and what still needs a real root, systemd or Windows run.

## Problem

Version 1 updated only the Node application inside a service-owned slot. The launcher and the bundled Node runtime in `/opt/bmuster-server` stayed fixed until someone re-ran the installer, so `bmuster-server --version` said 0.3.0 while 0.3.2 was running, and Node security fixes never reached installed servers. Jack does not want any part of BMuster to need a manual update.

## Design

**The web app says when; a root updater decides what.** An update is the installer running itself, for the whole install.

1. **Request.** An admin confirms **Update now**. The app (unprivileged) writes an empty file `<data>/update-requested`. That is all the app can do. The flag's contents are ignored.
2. **Trigger.** On Linux, `bmuster-server-update.path` (`PathExists=`) starts `bmuster-server-update.service`, a root one-shot that runs `/opt/bmuster-server/current/bmuster-server update --data-dir <data>`. On Windows, a SYSTEM scheduled task runs the same command every two minutes and exits at once when there is no flag.
3. **Updater.** It deletes the flag first (no loops), takes an exclusive lock, and then, writing each step to `<data>/update-status.json` (readable by the service user, writable only by root):
   1. asks GitHub for the latest stable release (the version 1 channel rules: no drafts or prereleases, validated repository and asset names);
   2. downloads the signed manifest and the bundle for its own target over HTTPS with size limits;
   3. verifies the manifest's Ed25519 signature against the release public key **compiled into the updater**, then the bundle's size and SHA-256; refuses anything not newer than the running version (no downgrades);
   4. extracts the bundle to `/opt/bmuster-server/releases/<version>.incoming` with the version 1 archive rules (no traversal, links or unexpected files), then renames it to `releases/<version>`;
   5. stops the service; writes a pre-update database copy to `<data>/backups/pre-update-<old>-to-<new>.db` (the stopped server has checkpointed its WAL);
   6. writes the switch record `<data>/update-switch.json` (`from`, `to`, `step`), then atomically repoints `/opt/bmuster-server/current` (a symlink replaced with `rename`) to the new release;
   7. lets the new release refresh its own unit files (`bmuster-server install --refresh-units`), reloads systemd and starts the service;
   8. waits up to 120 seconds for the readiness reply with the expected version (the version 1 readiness file and nonce);
   9. **healthy:** deletes the switch record, keeps the previous release, deletes releases older than that, and records `healthy`;
   10. **not healthy:** repoints `current` to the previous release and starts it, if the new release's manifest declares `rollbackCompatibleFrom` covering the old version (migrations are additive; the old app must accept the newer schema). Otherwise it leaves the service stopped and records `failed` with recovery instructions naming the pre-update database copy. The database is never replaced automatically.
4. **Interruption.** The updater service also runs `--recover` at boot (`Before=bmuster-server.service`). A leftover switch record is completed or rolled back with the same rules. Every step is safe to repeat.
5. **The app** reads `update-status.json` to show progress, and the version 1 page behaviour (stay rendered across the restart, reload when healthy or rolled back) is kept.

**Layout.** `/opt/bmuster-server/releases/<version>/{bmuster-server, node/, app/, VERSION}` and `/opt/bmuster-server/current → releases/<version>`. The service runs `/opt/bmuster-server/current/bmuster-server run`. The launcher is part of each release: it starts Node, restarts it if it crashes and hands the database lock over, but it no longer downloads, stages or switches anything. `bmuster-server --version` and the console both show the one running version.

**Installer.** `bmuster-server install` creates the same layout from an extracted bundle and installs the `.service`, `.path` and updater units. `docs/install.sh` additionally verifies the manifest signature (with the public key printed in the script) instead of trusting a checksum downloaded beside the archive.

**Moving from version 1.** A version 1 launcher cannot get root, so moving to this layout needs the installer re-run once (the Updates page says so for v0.3.x servers). From then on every part updates itself.

**Docker/Coolify** is unchanged: the image is the update, and the page explains how to deploy the new tag.

### Agents

The agent already runs as root and updates its worker under `<data>/versions` with a health check (SPEC-AGENT-UPDATES). Its launcher stays fixed in `/opt/bmuster/bmuster-agent`. Change:

- The unit runs `<data>/versions/current/bmuster-agent launch`, so the launcher is the current version's own binary and updates with it. The binary in `/opt/bmuster/bmuster-agent` becomes the **rescue copy**: the installer's binary, used only to roll back. _Since SPEC-SESSION-UNITS (Version 3):_ `/opt/bmuster/versions/current/bmuster-agent launch`.
- `OnFailure=bmuster-agent-rescue.service` (with `StartLimitBurst=3` in 5 minutes) runs `/opt/bmuster/bmuster-agent rescue`, which repoints `current` to `previous` and starts the agent again, recording the reason for the next check-in.
- Each healthy agent version also refreshes the rescue copy from itself after 24 hours of health, so the rescue copy is at most one version behind.
- Windows: the service's recovery actions run `bmuster-agent.exe rescue` from Program Files, with the same rules.
- `bmuster-agent --version` prints the running version; the check-in reports the rescue copy's version as `launcherVersion`.

## Security

This is security work: the updater runs as root and installs code that controls every enrolled machine.

- The web app never gains root, Administrator or a way to choose what is installed. A compromised app can at most trigger an update to the genuine latest signed release.
- The release key stays offline; its public half is compiled into the updater and the agent. Fail closed on any signature, version, target, size or hash problem. No unsigned fallback.
- `update-requested` lives in the service-owned data folder; everything the updater writes outside it is root-owned. The updater refuses to follow symlinks in the data folder.
- The release workflow refuses to publish without signatures (version 1 rule, kept).

## Acceptance criteria

| #    | Criterion                                                                                                                                                                                                                                                                                                                      | Named test                                                      |
| :--- | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :-------------------------------------------------------------- |
| SU1  | Checks: daily and Check now, coalesced, bounded retries, truthful failures (version 1 SU1, kept).                                                                                                                                                                                                                              | `server-release.test.ts`, `service.test.ts`                     |
| SU2  | Update now writes only the empty flag; admin-only, origin-checked and audited; refused for Docker and source runs.                                                                                                                                                                                                             | `server-update-guards.test.ts`                                  |
| SU3  | The updater ignores flag contents, deletes the flag first, holds one lock and refuses symlinked data paths.                                                                                                                                                                                                                    | Rust `updater::tests::flag_is_only_a_trigger`                   |
| SU4  | Verification: signature with the compiled key, target, size, hash, newer-only; archive rules.                                                                                                                                                                                                                                  | Rust `updates::verification`, `updates::archive` (kept)         |
| SU5  | The switch repoints `current` atomically, keeps one previous release and prunes older ones.                                                                                                                                                                                                                                    | Rust `updater::tests::switch_keeps_previous_and_prunes`         |
| SU6  | Healthy within 120 s commits; unhealthy rolls back only when declared compatible, else stops with instructions; the database is never replaced.                                                                                                                                                                                | Rust `updater::tests::health_commit_and_rollback_rules`         |
| SU7  | Interruption at every step is recovered at boot by `--recover`.                                                                                                                                                                                                                                                                | Rust `updater::tests::recover_from_every_step`                  |
| SU8  | Installer and updater make the same layout and units; `--version` reports the running release.                                                                                                                                                                                                                                 | Rust `install::tests::layout_and_units`, `service_linux` tests  |
| SU9  | Updates page shows updater progress from the status file, survives the restart and reloads when healthy or rolled back.                                                                                                                                                                                                        | `server-restart-monitor.test.ts`, `updates-page.svelte.test.ts` |
| SU10 | Agent: the unit runs the current version, a failing start rolls back through the rescue copy, and the rescue copy refreshes after 24 h.                                                                                                                                                                                        | Rust `launcher::tests::rescue_rolls_back`, `rescue_refresh`     |
| SU11 | `install.sh` verifies the manifest signature before installing.                                                                                                                                                                                                                                                                | `install-scripts.test.ts`                                       |
| SU12 | Release workflow: signed bundles only; a scratch install updates A→B and rolls back a broken B.                                                                                                                                                                                                                                | release dry run, scratch update test                            |
| SU13 | The "BMuster X is available" notice in the console frame shows only while a release waits and no update is requested or running, and never on the Updates page (Jack, 2026-11-11: it appeared during an update).                                                                                                               | `server-update-notice.test.ts`                                  |
| SU14 | While the server updates, the Updates page says "BMuster is updating to X. Please wait." under the radar, counts down the usual minute ("About 42 seconds left", then "Taking a little longer than usual"), says the page reloads by itself, and shows the updater's latest step. This replaces the radar-alone view of 0.4.7. | `update-wait.test.ts`, `updates-page.svelte.test.ts`            |

## As built (pending release, 2026-11-09)

### Criteria and their tests

| #    | Test as built                                                                                                                                   | How it was run                                 |
| :--- | :---------------------------------------------------------------------------------------------------------------------------------------------- | :--------------------------------------------- |
| SU1  | `server-release.test.ts`, `service.test.ts` (unchanged behaviour)                                                                               | Natively                                       |
| SU2  | `server-update-guards.test.ts`: empty flag only, audit, second request refused, Docker/source refused, 401/403, cross-origin refused            | Natively                                       |
| SU3  | Rust `updater::tests::flag_is_only_a_trigger`, `updater::files::tests::links_in_the_data_folder_are_never_followed`                             | Natively                                       |
| SU4  | Rust `updates::manifest::tests::verification`, `updates::archive::tests::*`, `updater::tests::refused_releases_change_nothing`                  | Natively                                       |
| SU5  | Rust `updater::tests::switch_keeps_previous_and_prunes`, `releases::tests::*`                                                                   | Natively                                       |
| SU6  | Rust `updater::tests::health_commit_and_rollback_rules`                                                                                         | Natively                                       |
| SU7  | Rust `updater::tests::recover_from_every_step` (every step, both link states, at boot and not)                                                  | Natively                                       |
| SU8  | Rust `install::tests::layout_and_units`, `service_linux::tests::*`; `service_windows::tests::*` (Windows only)                                  | Linux natively; Windows compiled only          |
| SU9  | `server-restart-monitor.test.ts`, `updates-page.svelte.test.ts` (the two SU9 cases)                                                             | Natively                                       |
| SU10 | Rust `rescue::tests::rescue_rolls_back`, `rescue::tests::rescue_refresh`, `service_linux::tests::a_failing_start_runs_the_rescue_copy`          | Logic natively; systemd and Windows not run    |
| SU11 | `tests/unit/install-scripts.test.ts` (the real script, real OpenSSL; signed, other key, project key, tampered, no manifest)                     | Natively                                       |
| SU12 | `npm run server:update-test` (`scripts/server-update-scratch-test.ts`), run by the release workflow's `update-test-linux` job before publishing | Scratch test natively; release dry run not run |

The SU10 tests live in `rescue.rs` (`rescue::tests`), not `launcher::tests`.

### How it differs from the design

- **The switch record and the updater's lock live in the program folder** (`/opt/bmuster-server/update-switch.json`, `update.lock`), not the data folder: recovery acts on the record, so only root may be able to write it. `update-requested`, `update-status.json`, `ready.json` and the database copy are in the data folder as designed; the updater never follows a link there (`O_NOFOLLOW`, or `FILE_FLAG_OPEN_REPARSE_POINT` on Windows), replaces files by rename, and refuses a linked data folder or `backups/` folder.
- **Boot recovery decides without a health check**, because the server unit waits for it: interrupted while switching (the new release never ran) → back to the old release; while starting → back if the new release declares the old one compatible, else the new one stays; while rolling back → finished. The path-triggered (Windows: scheduled) updater recovers with the same rules, stopping and starting the service around them. The recovery unit runs only when the record exists (`ConditionPathExists`).
- **Manifest field names are unchanged** (`rollbackFrom` is the design's `rollbackCompatibleFrom`; `minimumLauncher` now means the oldest installed version whose updater may install the release by itself), because v0.3.x servers parse the manifest strictly. The release keeps the v0.3.x asset names, `bmuster-app-<target>.tar.gz` and `.json`, but the archive is now the whole install. So a v0.3.x server sees the new release and shows its own "This release needs a newer launcher. Rerun the administrator installer." `server-update-sign.ts` now requires an explicit entry in `docs/server-update-compatibility.json` and refuses a `minimumLauncher` of 0.3.3 or older for any later release. **Before the first tag, add that release's entry with `minimumLauncher` set to its own version.**
- **One Linux archive.** The signed bundle is what install.sh, the updater and the container image use; `bmuster-server-linux-*.tar.gz` and the SHA256SUMS check in install.sh are gone. Windows keeps `bmuster-server-windows-x64.zip` for install.ps1 (still SHA256SUMS-checked; signing it is outside this spec) plus its tar.gz bundle for the updater.
- **install.sh needs OpenSSL 3** (`pkeyutl -rawin` for Ed25519) and fails closed without it. `--archive` now needs the signed manifest beside the archive; a local build is installed by running its unpacked `bmuster-server install`.
- **Readiness:** the app writes `ready.json` as `{nonce, version}`; the launcher takes the nonce from the switch record when the record names its version. `BMUSTER_LAUNCHER_VERSION` is gone (the launcher is part of the release).
- **The launcher restarts a crashed app itself**, waiting 2 s and doubling to a minute.
- **No session pause before an update.** The relay's `prepareForServerUpdate`, `resumeAfterServerUpdate` and `accepting` went with the preparation step; sessions end when the updater stops the service.
- **Windows agent:** the service still runs the Program Files copy, which is also the rescue copy, because Windows cannot rename the folder of a running program (the launcher switches `versions/current`). Recovery actions: restart, restart, then `bmuster-agent.exe rescue`. Only crashes count, so a removed machine's clean stop is not a failure. On Linux, `OnFailure` fires after three failed starts in five minutes, and `SuccessExitStatus=3` keeps a removed machine from triggering the rescue.
- **Rescue refresh:** after 24 hours of check-ins in one run, the worker runs `refresh-rescue` (Linux: as a transient unit outside the sandbox, through `systemd-run`; Windows: in the worker). It copies itself over the rescue copy, records `rescue-copy.json` (in `/var/lib/bmuster` since SPEC-SESSION-UNITS Version 3), and rewrites the agent's units. That also moves agents installed before this change onto the new unit from their next start, with no reinstall.
- **`launcherVersion`** is reported in every check-in and parsed by the server, but not yet stored or shown (that needs a column).
- **Scratch-test seams:** with `--features scratch-test` (never in a release build) the updater reads releases from `BMUSTER_UPDATE_TEST_SOURCE`, drives the service with `BMUSTER_UPDATE_TEST_SERVICE`, and takes a shorter health window from `BMUSTER_UPDATE_TEST_HEALTH_SECONDS`. As for the agent, `BMUSTER_EXTRA_RELEASE_KEY` at build time adds one trusted key. Every check is the release build's own.

### Tested natively, and what still needs a real machine

- **Run natively here** (Linux x64, no root): the Rust unit tests, plus the scratch end-to-end test. That test builds the real launcher and updater, uses the real Node with stand-in apps, and installs with `install --no-service`. It covers the `releases/` and `current` layout, a request with no flag, A→B kept healthy with A as previous and a database copy, a release signed by another key refused, a broken release that declares compatibility rolled back, a broken one that does not stopped with instructions naming the copy, and `update --recover` finishing an interrupted rollback. Also run natively: install.sh with real OpenSSL, and the console tests.
- **Only unit-tested or compiled:** the systemd units for real (the path unit starting the updater, boot ordering, `install --refresh-units` and `systemctl` as root), root ownership and modes on `/opt` and `/var/lib`, the GitHub source over HTTPS, a real `npm run release:server-local` bundle, the agent's rescue under systemd (`OnFailure`, `StartLimitBurst`, `systemd-run` refresh), and all Windows behaviour: the server service through the `current` link, the scheduled task, `MoveFileEx`, the agent's recovery actions and rescue copy. Windows code was type- and clippy-checked only, with `x86_64-pc-windows-gnu`. The release workflow's dry run was not run.

## Version 1 (v0.3.0–v0.3.3, replaced)

The unprivileged launcher downloaded a version named by the app (`request.json`), verified it and switched between `current`/`previous`/`incoming` application slots under the data folder, with a durable state file and readiness check. The launcher and Node runtime were fixed. The verification, archive, download and readiness code carries over into the updater; the slot supervisor, `request.json`, `prepare.json`/`prepared.json` and the app-side preparation step are deleted.

# SPEC-TEST-CHANNEL: Test builds for a chosen machine group

**Status:** `IMPLEMENTED (pending release)` 2026-11-11 · approved 2026-11-11 (Jack: "Prerelease tags would go only to a 'Test' machine group") · **Date:** 2026-11-11

## Problem

A fix aimed at one machine (the Fedora laptop's Wayland fixes, for example) can only reach it by cutting a full release, which then rolls out to every machine on every server. There is no way to try a build on one machine first while everyone else stays on full releases.

## Behaviour

1. **Test builds.** A tag with a Semantic Versioning pre-release part (`v0.4.14-test.1`) builds and signs the agent exactly like a release (same jobs, same glibc floor, same offline release key) and publishes it as a GitHub **pre-release**, never marked "latest". Its assets are the signed agent builds, `bmuster-agent-<target>[.exe]` with `bmuster-agent-<target>[.exe].sig`, and `SHA256SUMS`.
2. **Ordering.** Versions follow Semantic Versioning precedence everywhere (server TypeScript, agent Rust): `0.4.13 < 0.4.14-test.1 < 0.4.14-test.2 < 0.4.14`. The full release later supersedes a test build without a "not newer" refusal; a test build older than a machine's version is never offered.
3. **Test group.** A built-in machine group _Test_ (id `00000000-0000-4000-8000-000000007e57`, `built_in = 'test'`), made by a migration like Early updates (an existing group called "Test", any case, is adopted with its machines and rules). It cannot be renamed, changed or deleted; admins add and take out machines on the Groups page as for any group.
4. **Fetching test builds.** While the Test group has machines and update checks are on (`serverUpdateChecks`), the server asks GitHub for its releases every hour and on Check now. It takes the newest pre-release that is newer than the newest full agent build it already has, downloads each target's build and signature, checks the declared size and the release signature with the project key, and only then stores it in `<data>/agent-test-builds/<version>/<target>/`. Older test builds are deleted. A failure stores nothing and is shown on the Updates page with its reason.
5. **Offering.** A machine in Test is offered the newest of (the newest test build, the newest full build) for its target. A test build is offered at once, with no stages and no roll-out pause, but still respects pins, Manual mode, Update now and an earlier failure of that version. Machines outside Test are never offered a test build, by check-in or by Update now; they follow the newest full build with the staged roll-out, unchanged. A Test machine on a test build gets the next full release once that is newer.
6. **Server updates stay on full releases.** The app's update check and the root updater (`bmuster-server update`) ask GitHub only for the latest stable release and refuse any pre-release, so a newer test build on GitHub is never offered to the server. No setting is added.
7. **Console.** The Updates page has a _Test channel_ panel: the newest test build on offer (or none), which Test machines run it, the Test group's machine count with a link to it, and the last fetch problem. Each machine row says its channel: _Test channel_ or _Full releases_.
8. **Audit.** Adding and taking out Test machines is audited as group membership. A test build install is audited as `agent-updated` with `from` and `to`, like any agent update; a rollback or refusal of a test build is audited but does not pause the full roll-out.

## Acceptance criteria

| #   | Criterion                                                                                                                                                                                            | Test                                                                                                                                             |
| :-- | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :----------------------------------------------------------------------------------------------------------------------------------------------- |
| T1  | `0.4.13 < 0.4.14-test.1 < 0.4.14-test.2 < 0.4.14` in TypeScript and Rust; the agent accepts the full release over a test build and refuses an older test build.                                      | `agent-version.test.ts` (T1), Rust `updates::tests::versions_follow_semver_precedence`, `updates::tests::a_full_release_supersedes_a_test_build` |
| T2  | The release workflow decides the kind from the tag: `vX.Y.Z` equal to package.json is a release; `vX.Y.Z-<pre>` equal to agent/Cargo.toml is a pre-release; anything else fails.                     | `tests/unit/release-kind.test.ts` (T2)                                                                                                           |
| T3  | The Test group is built in: made by the migration (or adopted), listed after Early updates, cannot be renamed or deleted, and takes machines.                                                        | `early-updates-migration.test.ts` (T3), `machine-groups.test.ts` (T3)                                                                            |
| T4  | A test build is offered only to Test machines, at once; others get only full builds, by check-in and Update now; pins, Manual mode and a failure hold it back.                                       | `agent-updates.test.ts` (T4), `releases.test.ts` (T4)                                                                                            |
| T5  | A Test machine on a test build is offered the next full release once that is newer, and never an older test build.                                                                                   | `agent-updates.test.ts` (T5)                                                                                                                     |
| T6  | Fetching: the newest pre-release newer than the full build is downloaded, signature- and size-checked and stored; a bad signature, wrong size or missing asset stores nothing; older test builds go. | `test-builds.test.ts` (T6)                                                                                                                       |
| T7  | Server updates ignore pre-releases: GitHub's answer naming a pre-release is refused by the app check and the root updater.                                                                           | `server-release.test.ts` (T7), Rust `updates::download::tests::a_prerelease_is_never_the_latest_release`                                         |
| T8  | The Updates page shows the Test channel panel (build on offer, its machines, the group link, a fetch problem) and each machine's channel.                                                            | `updates-page.svelte.test.ts` (T8)                                                                                                               |
| T9  | A test build install is audited as `agent-updated` with the test version; its rollback does not pause the full roll-out.                                                                             | `agent-updates.test.ts` (T9)                                                                                                                     |

## Security notes

This is agent-update work, so it is security work (AGENTS.md §11).

- The server still never signs anything. A test build is signed by the same offline release key as a full release; the agent verifies the signature, target, size and SHA-256 with its compiled keys and refuses anything not newer, exactly as before. Nothing in the agent changed.
- The server checks the signature itself before storing a downloaded build (defence in depth; fail closed), downloads only from GitHub over HTTPS with the existing trusted-host and size limits, and only asset names it builds itself.
- A compromised server could at most offer a genuine signed test build, which it can already download from GitHub; it gains nothing new.
- Server self-update remains stable-only: the signed server manifest, the root updater and `install.sh` still accept only `X.Y.Z` versions, so no pre-release server bundle exists or is installed.

## Schema changes

- `machine_groups.built_in` may also be `'test'` (TypeScript enum only; SQLite text).
- Migration `0016_test_group` (generated with `drizzle-kit generate --custom`, DML appended): adopts or creates the Test group.

## Open questions

1. Should a test build's rollback on one Test machine stop it for the other Test machines? As built: no, each machine stops on its own failure only.
2. Should the server also publish test server bundles? As built: no (see "As built").

## As built (2026-11-11)

- **Only the agent is a test build.** A pre-release tag publishes the signed agent builds and skips the server archives, install tests, scratch update test and container image. Server bundles, `install.sh` and the root updater accept only stable versions by design; building a test server would have meant loosening those checks.
- **Versions.** For a test build, set `agent/Cargo.toml`'s workspace version (and `Cargo.lock`) to `X.Y.Z-test.N`; `package.json` and the changelog stay on the last release. Then `git tag vX.Y.Z-test.N && git push origin vX.Y.Z-test.N`.
- **Where builds live.** `<folder of DATABASE_PATH>/agent-test-builds`, beside the database in every deployment (installed, Docker, source). The agent download route serves from it as well as from `RELEASES_PATH`; Add machine still hands out only full builds.
- **Downloads** use the server update check's bounded HTTPS download (20 s per request, three tries), so a very slow link may need a second Check now.

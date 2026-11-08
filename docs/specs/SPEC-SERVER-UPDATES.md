# SPEC-SERVER-UPDATES: Check, install and recover server updates

**Status:** Implementation built for v0.3.0 candidate · 2026-11-08 · release/update integration gates remain pending.

## Open decisions and security

This is security work: a server update controls the console and every enrolled machine.

The approved product flow is a daily GitHub check, an immediate **Check for updates** button, an update notice and modal, followed by an installed-service update or Docker instructions. The earlier conversation did not resolve these implementation constraints:

1. Installed services run as `bmuster-server` on Linux and LocalService on Windows. They can write their data folder, but cannot replace `/opt/bmuster-server` or Program Files. Keep those privileges unchanged. Use the existing launcher to supervise signed application versions in a dedicated, service-owned version folder, rather than granting the web process root or Administrator. The fixed launcher and its bundled runtime are upgraded by rerunning the administrator installer. Changes requiring a new launcher/runtime show those instructions instead of offering an in-console update.
2. A checksum fetched beside an archive detects corruption; it does not authenticate the archive. Sign the server update manifest with the offline release key and verify it in the launcher against its compiled public key. Fail closed when the signature, target, version, size or hash is wrong. Never publish a production release without signatures.
3. A healthy HTTP response alone is insufficient after a schema change. Only offer automatic rollback when the release declares compatibility with the previous application's schema and this is exercised in release tests. Keep an online SQLite backup before applying migrations, but never automatically overwrite the operator's database to roll back. A schema incompatibility requires operator recovery with explicit instructions.

Recommendation: approve all three constraints. They preserve the existing service permissions and make the limit of automatic rollback explicit.

## Mental model

A GitHub release is a box containing the server and its signed agents. Checking for updates only looks for a newer box. For a compatible installed-service update, the launcher validates and stages the new application, stops the old application, starts the new one and waits up to two minutes for readiness and the expected version. It retains the previous application for recovery. The persistent database, settings and secrets stay in the data folder.

Once healthy, the new server offers its agents through the existing staged rollout. Updating the server does not mean every machine updates immediately: pins, pauses, manual policy and offline machines still apply. The Updates page shows these states as they change.

For Docker/Coolify, the image is the box. BMuster reports the newer version and explains which image tag to deploy. It never mounts the Docker socket or changes the container from inside.

## Acceptance criteria

| #    | Behaviour                                                                                                                                                                                                                      | Named test                                                          |
| :--- | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :------------------------------------------------------------------ |
| SU1  | Check GitHub daily when enabled; Check now performs a new check immediately. Coalesce concurrent requests and show rate-limit/network errors with the last successful result labelled by time.                                 | `server-update-check.test.ts`                                       |
| SU2  | Only newer, supported releases are offered; drafts and prereleases are excluded on the stable channel; validate repository, asset names, sizes and metadata.                                                                   | `server-release.test.ts`                                            |
| SU3  | Admin-only check/install endpoints; no install for Docker, source dev runs or incompatible launcher versions. Changes are audited and origin checked.                                                                          | `server-update-guards.test.ts`                                      |
| SU4  | Banner and modal show installed/new versions, release notes, interruption of sessions and staged agent rollout. Installation requires confirmation.                                                                            | `server-update-panel.svelte.test.ts`                                |
| SU5  | Launcher verifies the signed manifest, version, target, size and SHA-256 before activation; bounded HTTPS downloads and extraction reject traversal, links and unexpected files.                                               | Rust `server::updates::verification` and `server::updates::archive` |
| SU6  | Fixed launcher supervises current/previous/incoming application slots with a durable switch record; interruption at every switch step recovers deterministically. Runtime/launcher changes require administrator installation. | Rust `server::updates::recovery`                                    |
| SU7  | Staged application must answer readiness with its expected version within 120 seconds; compatible failure restores the previous application and records the reason. Database is never replaced automatically.                  | Rust `server::updates::health`, scratch-server rollback test        |
| SU8  | Only one updater runs; active sessions are ended with a clear update reason; the database lock is handed over before the next app starts.                                                                                      | `server-update-handover.test.ts`                                    |
| SU9  | Updates page refreshes every visible few seconds and shows every machine's version, stage/estimated turn, pins, failures and offline state; filters preserve scroll and selection.                                             | `updates-live.svelte.test.ts`                                       |
| SU10 | Release workflow signs server manifests and agent builds and tests compatible A→B and broken B→A before publication. No unsigned release fallback.                                                                             | release dry run and scratch install/update test                     |
| SU11 | Docker notice gives tag/deploy instructions and has no self-update action; checks can be disabled and manually requested.                                                                                                      | `server-update-panel.svelte.test.ts`, `server-update-check.test.ts` |

## Schema and routes

Use the existing typed settings for automatic-check policy. Store only validated release metadata, check times and a visible failure reason; no release signing secrets live on the server. Persist updater state beside the version slots, with restrictive file permissions. Any new database columns or tables require generated additive migrations.

Proposed admin endpoints: `POST /api/server-updates/check`, `POST /api/server-updates/install`, `GET /api/server-updates`. A readiness reply includes the running application version. Deployment mode and launcher compatibility are supplied by trusted local startup configuration, never a browser field.

## Build order

1. Signed manifest contract, release verification and version bookkeeping.
2. Update checks, manual Check now, notice/modal, Docker instructions and live agent rows.
3. Launcher slots, authenticated local update request, staging and crash recovery on Linux.
4. Scratch integration test: normal update, bad signature, failed readiness, crash recovery and schema compatibility.
5. Windows implementation and real Windows test; first publication only after the workflow dry run.

## Current limits

The v0.3.0 candidate introduces the first server self-update-capable launcher. The existing administrator installer remains required to move from earlier versions whose launcher has no update supervisor. No release is tagged or published by this document. The release key's presence in GitHub must be checked without revealing its contents before a release dry run.

## As built

- The Rust launcher supervisor has bounded downloads, Ed25519 manifest
  verification, archive validation, version slots, health/readiness confirmation,
  durable recovery state and rollback to the prior application slot. The
  launcher and bundled Node runtime remain fixed; an administrator installer
  is required when either changes. Existing database files are never rolled
  back automatically.
- The Node app checks GitHub's latest stable release daily and on an
  administrator-triggered request, stores bounded release metadata, audits
  checks and update requests, and serves admin-guarded check/install/view APIs.
  The console shows a global notice, confirmation panel and live agent rollout
  rows. Docker/source runs explain that an installer or image deployment is
  required.
- The release workflow builds Linux x64, Linux arm64 and Windows x64 bundles,
  signs agent and app manifests, and uploads dry-run artifacts on manual
  dispatch. The initial v0.3.0 manifest intentionally has no rollback source;
  the first supported self-update is from v0.3.0 to a later release that
  explicitly declares tested compatibility.
- Automated unit coverage exercises manifest verification, extraction
  restrictions, updater state recovery, preparation requests, check coalescing
  and cached-release handling. The existing workflow install test verifies
  install/reinstall/uninstall, but does **not yet** exercise a real app A→B
  update followed by failed-readiness rollback. Native Windows service
  update/recovery has not been run. These remain release gates and are not
  claimed as verified behaviour.

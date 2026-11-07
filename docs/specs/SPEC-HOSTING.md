# SPEC-HOSTING: The container image and hosting behind a reverse proxy

**Status:** `IMPLEMENTED` (decisions approved by Jack 2026-11-07; built 2026-11-07, see As built; version bump left for the release step) · **Date:** 2026-11-07

## 1. Problem

BMuster installs as a service (SPEC-SERVER-INSTALL), but an operator's instance may run on Coolify behind Nginx Proxy Manager. That needs a container image, a safe way to deploy a new version over the old one, and a database copy that a VM backup cannot catch half-written.

**Security note.** The image sits behind two proxies, so the client address the sign-in limit and the audit log use comes from `X-Forwarded-For`. The proxy depth is set so a client cannot choose its own address (section 5). Nothing here changes sign-in, access or the agent channel.

## 2. Decisions (approved 2026-11-07)

- GitHub Actions builds the image with the agents inside and publishes it to GHCR as `ghcr.io/jackbrumley/bmuster`, for amd64 and arm64. Coolify pulls it by version tag.
- The first deployment is an operator's production instance on Coolify, on its own Coolify destination and network.
- The image is built from the release archives, not from source, so it runs exactly what the archives hold.

## 3. Acceptance criteria

| #   | Criterion                                                                                                                                                                                                                                                                                                                                                                                                                          | Test                                                   |
| :-- | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :----------------------------------------------------- |
| H1  | `docker/app/Dockerfile` builds from an unpacked Linux archive per architecture: `node:<.node-version>-bookworm-slim`, user `node`, working folder `app/`, agents at `RELEASES_PATH=/opt/bmuster/releases`, `DATABASE_PATH=/data/bmuster.db`, `VOLUME /data`, port 8080, a `HEALTHCHECK` on `/readyz` with Node's `fetch`, and adapter-node's proxy settings. `npm run docker:local` builds it from `npm run release:server-local`. | manual (section 7); `image` job smoke test             |
| H2  | Before the app loads, `server.js` takes an operating-system lock on `<database>.lock`. A second server on the same database logs why it waits, takes the lock when the first exits, and stops with a clear message after 120 s. Nothing listens while it waits, so `/readyz` passes only with the lock held and migrations applied. The installed service (`bmuster-server run`) is unchanged.                                     | `data-lock.test.ts`, manual (section 7)                |
| H3  | A built server writes a snapshot of its database every day with SQLite's online backup API to `backups/bmuster-YYYY-MM-DD.db` beside it, under a temporary name then renamed, keeping the newest `BMUSTER_BACKUP_KEEP` (14; 0 turns it off) at `BMUSTER_BACKUP_TIME` (HH:MM, 03:00, the server's time zone). Each run is logged. The dev server never writes snapshots.                                                            | `snapshots.test.ts`, `env.test.ts`, manual (section 7) |
| H4  | `.github/workflows/release.yml` job `image`, after both install tests, unpacks the two Linux archives (checked against `SHA256SUMS`), builds and smoke-tests the amd64 image, then builds amd64 and arm64 and, on a tag only, pushes `vX.Y.Z`, `X.Y` and `latest` to GHCR with `GITHUB_TOKEN` (`packages: write`). Every action is pinned to a commit SHA. A manual run builds without pushing.                                    | review; first real run on GitHub                       |
| H5  | `docs/hosting.md` is an operator's checklist for Coolify and Nginx Proxy Manager, with placeholders for names and addresses: how it fits together, the Coolify resource, the NPM proxy host, Traefik trusting NPM, backups and upgrades.                                                                                                                                                                                           | review                                                 |

## 4. Rolling deploys and the lock

Coolify starts the new container before it stops the old one. With Coolify's own health check **off** (the image has its own), a Docker Image resource counts the new container as healthy at once and stops the old one straight away; the new one has been waiting on the lock and starts as soon as the old one exits. Traefik routes only to healthy containers, so requests go to the old server until it stops and to the new one once `/readyz` passes, with a gap of a few seconds.

With Coolify's health check **on**, Coolify would wait for the new container to be healthy before stopping the old one, which never happens while the old one holds the lock: the deploy fails after the health check's retries and the old container keeps serving. So the guide says to leave it off.

## 5. Proxy headers

- `ADDRESS_HEADER=X-Forwarded-For` and `XFF_DEPTH=2`: NPM appends the client's address and Traefik (once it trusts NPM) appends NPM's, so the client is second from the right. Anything a client sends itself sits further left and is ignored.
- If Traefik does not trust NPM, it replaces the header with NPM's address alone and adapter-node refuses to guess: sign-in fails with `XFF_DEPTH is 2, but only found 1 addresses` in the log. That is deliberate: every client sharing NPM's address would share one sign-in limit.
- `PROTOCOL_HEADER=x-forwarded-proto`, `HOST_HEADER=x-forwarded-host`: the request's origin, which SvelteKit's and BMuster's cross-site checks compare with the browser's `Origin`. adapter-node 6 has no `ORIGIN` variable (the origin is the build-time `kit.paths.origin`, which a shared image cannot know), so these headers must arrive, which also needs Traefik to trust NPM.
- `BODY_SIZE_LIMIT=16M`: file transfers send 8 MB chunks.

## 6. Out of scope

- Signing the image, SBOMs and image scanning.
- Docker Compose files and other hosts than Coolify (the image works anywhere; the guide covers Coolify).
- An admin page for snapshots; restoring is a manual copy (docs/hosting.md).

## 7. Testing

- Unit: `data-lock.test.ts` (free lock, wait and hand-over, timeout message, a lock held by another process until it is killed), `snapshots.test.ts` (names, rotation, a whole copy under the final name only, same-day replacement, next run time), `env.test.ts` (H3 settings).
- Manual, local Docker: build the image with `npm run docker:local`, run it on a spare port with a scratch bind mount, check `/readyz`, finish `/setup` with the printed code through simulated proxy headers (session and audit show the client address), download an agent and compare its SHA-256, start a second container on the same folder (it waits and logs why, then serves once the first stops), and run a snapshot by setting `BMUSTER_BACKUP_TIME` a minute ahead.
- Not testable here: the workflow (runs only on GitHub), the arm64 image, Coolify, NPM and Traefik themselves.

## 8. As built

- **Lock (H2).** `database/data-lock.ts`: `acquireDataLock` opens `<database>.lock` with better-sqlite3, sets `locking_mode = EXCLUSIVE` and leaves `BEGIN EXCLUSIVE` open (fcntl on Linux, LockFileEx on Windows); `SQLITE_BUSY` means another process holds it, retried every second. The module keeps every held connection in a set, because a connection nothing refers to is closed by the garbage collector, which releases the lock (found while testing: a holder in a `node -e` script lost its lock this way). `server.ts` takes it before importing `build/handler.js` (which opens and migrates the database) and skips it for `:memory:`; the "listening" line names the lock. SQLite leaves a 512-byte `bmuster.db.lock-journal` beside it; it is harmless. The dev server takes no lock.
- **Snapshots (H3).** `database/snapshots.ts`, scheduled from the `init` hook when not in dev and the database is a file, using `database.$client.backup()` (`AppDatabase` now includes `$client`). The temporary name is `.bmuster-YYYY-MM-DD.db.partial`. Results and failures are logged, not audited: a daily entry would crowd Activity. `env.ts` reads `BMUSTER_BACKUP_TIME` and `BMUSTER_BACKUP_KEEP` as `backupSchedule`; both are in `.env.example`, so installed servers get snapshots in their data folder too.
- **Image (H1).** The image's own Node replaces the archive's `node/`; the launcher is left out (Docker is the service). `/data` is made in a stage that runs on the build machine and copied in owned by `node`, so no `RUN` runs on the target architecture and the workflow needs no QEMU. The health check uses `--start-period=120s --start-interval=2s` to cover the lock wait. `npm run docker:local` is `scripts/docker-local.ts`.
- **Origin.** adapter-node 6 has no `ORIGIN` variable (the setup-time report assumed one), so the guide tells Jack not to set it and to make Traefik trust NPM instead.
- **Workflow (H4).** Job `image` with actions pinned by SHA: checkout v7.0.1, download-artifact v8.0.2, setup-buildx-action v4.4.1, build-push-action v7.4.0, metadata-action v6.2.0, login-action v4.8.0. `latest` comes from metadata-action's `latest=auto`, so a pre-release tag does not move it. The rest of the workflow still uses major-version tags, unchanged here.
- **Guide (H5).** `docs/hosting.md`, generic (placeholders such as `bmuster.example.com`, `<npm-ip>`, `<coolify-host>`). It links to this spec, so like the specs it stays off the bmuster.com site (`docs/_config.yml`).
- **Manual run (2026-11-07, linux-x64, Docker 29.9).** All checks in section 7 passed. Port 47670 with a scratch bind mount: `/readyz` and `/healthz`; `/setup` finished through simulated proxy headers, with the session and audit IP `203.0.113.9` from `X-Forwarded-For: 203.0.113.9, 198.51.100.7`. A single-entry header gave the expected `XFF_DEPTH` error on sign-in. An agent download matched its SHA-256. A second container on the same folder logged that it was waiting, took the lock the moment the first stopped and was healthy 4 s later. A snapshot at a set time wrote `bmuster-2026-11-07.db` (integrity `ok`) and pruned to the newest two. `TZ=Australia/Melbourne` works in the slim image. The installed-service path (`install.sh --no-service`, `bmuster-server run`) started, held the lock, and a second `run` on the same data waited, then stopped after 120 s with the message.

# SPEC-SERVER-INSTALL: Installing the server with one command

**Status:** `IMPLEMENTED` (design approved by Jack 2026-11-07; built 2026-11-07, see As built; version bump and changelog left for the release step) · **Date:** 2026-11-07

## 1. Problem

BMuster only runs from source: clone, `npm install`, `npm run build`, write `.env`, keep `node server.ts` running. Visitors to bmuster.com should install the **server** with one command, on a Raspberry Pi, a VM or a Windows box, and then hand out agents from Add machine, which already works.

- Linux: `curl -fsSL https://bmuster.com/install.sh | sudo sh`
- Windows (PowerShell as Administrator): `irm https://bmuster.com/install.ps1 | iex`

bmuster.com is GitHub Pages served from `main` `/docs`, so `docs/install.sh` and `docs/install.ps1` are served at those addresses. They are a different thing from the server's own `/install.sh` and `/install.ps1`, which install the **agent** from a running server.

**Security note.** The installer sets up the program that controls every enrolled machine, and this spec adds a first-run switch for local network mode (I12) and two unauthenticated probe routes (I14). Nothing here weakens a check: the probes reveal only "up" or "ready", and the switch acts only while the server has no users, like `BMUSTER_ADMIN_EMAIL` (SPEC-SIGN-IN S18).

## 2. Decisions

- **One release archive per platform:** `linux-x64`, `linux-arm64` (Raspberry Pi, 64-bit OS) and `windows-x64`. Each holds the built server, a pinned Node runtime, every agent build and a small launcher, so nothing else needs installing.
- **Why not one compiled file:** `better-sqlite3` is a native module, so Node single-executable apps or `bun --compile` would break it or force a driver swap.
- **Pinned Node:** the version in `.node-version` (26.13.0, inside `engines` `>=26`). The packaging script downloads the official build from nodejs.org and checks it against nodejs.org's `SHASUMS256.txt`.
- **Launcher:** `bmuster-server`, a Rust crate in the `agent/` workspace. It runs the bundled Node on the server entry with the right environment, and is the service. The systemd and Windows service plumbing it shares with the agent lives in a new library crate, `bmuster-service`, used by both binaries.
- **glibc floor:** Linux builds (launcher and agents) are linked against glibc 2.31 with `cargo zigbuild`, so they run on Debian 11+, Ubuntu 20.04+ and Raspberry Pi OS (bullseye and bookworm, 64-bit), not only on the build runner's newer glibc. Node 26 itself needs glibc 2.28; the `better-sqlite3` and `@node-rs/argon2` prebuilds need less.
- **Default: local network mode on port 8443.** See section 6.

## 3. Acceptance criteria

| #   | Criterion                                                                                                                                                                                                                                                                                                                                 | Test                                                              |
| :-- | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :---------------------------------------------------------------- |
| I1  | `npm run release:server-local` builds this computer's archive in `dist/release/`: server build, bundled `server.ts`, production `node_modules`, migrations, pinned Node, this computer's agent and the launcher.                                                                                                                          | manual (section 9)                                                |
| I2  | `bmuster-server install` copies the bundle it was run from into the program folder (replacing an older one), creates the data folder, writes `server.env` once (new `SECRETS_KEY`) and keeps it on later runs, then registers and starts the service.                                                                                     | `bundle::tests`, `config::tests`, manual                          |
| I3  | `install --prefix <dir> --data-dir <dir> --no-service` does the same without root, a service or a system user, for tests and hand-run servers.                                                                                                                                                                                            | manual (section 9)                                                |
| I4  | `bmuster-server run` starts the bundled Node on `app/server.js` with `DATABASE_PATH` and `RELEASES_PATH` set from the data and program folders and `--env-file=<data>/server.env`; on Linux it replaces itself with Node.                                                                                                                 | `node::tests`, manual                                             |
| I5  | Linux: the unit `bmuster-server.service` runs `run --data-dir /var/lib/bmuster-server` as the system user `bmuster-server`, restarts on failure, writes only the data folder, and may bind ports below 1024.                                                                                                                              | `service_linux::tests`                                            |
| I6  | Windows: the service `BMusterServer` ("BMuster Server") runs `run --service` as `NT AUTHORITY\LocalService`, starts automatically, restarts after a failure, logs to `server.log` in the data folder, and has an inbound firewall rule for its port.                                                                                      | `service_windows::tests` (under Wine), `install-test-windows` job |
| I7  | `bmuster-server uninstall` removes the service (and firewall rule) and the program folder and keeps the data; `--purge` also deletes the data folder (and on Linux the system user).                                                                                                                                                      | manual                                                            |
| I8  | `bmuster-server status` shows the server version, the folders, the service state, the address and where the log is.                                                                                                                                                                                                                       | manual                                                            |
| I9  | `docs/install.sh` (POSIX `sh`) downloads the newest release archive for this machine (`x86_64` or `aarch64`), checks it against the release's `SHA256SUMS`, and runs `install`. Re-running it upgrades in place and keeps the data. `--version`, `--port`, `--prefix`, `--data-dir`, `--no-service` and `--archive <file>` are passed on. | `shellcheck`, manual (section 9)                                  |
| I10 | `docs/install.ps1` does the same on Windows x64 (Windows PowerShell 5.1 and PowerShell 7).                                                                                                                                                                                                                                                | `install-test-windows` job; not run here (no PowerShell)          |
| I11 | At the end both installers wait for `/readyz`, then print the address to open and the first-run setup code from the log (SPEC-SIGN-IN S17), or say exactly how to read it.                                                                                                                                                                | manual (section 9)                                                |
| I12 | `BMUSTER_LOCAL_NETWORK_MODE=on`, while the server has no users, turns local network mode on at start-up before the listener is chosen (audited as a setting change by the system). Any other value stops start-up. With users it does nothing.                                                                                            | `setup.test.ts`, `env.test.ts`                                    |
| I13 | `.github/workflows/release.yml` (tags `v*` and manual runs) builds the agents and launchers, then the three archives on native runners, writes `SHA256SUMS`, and on a tag publishes one GitHub release with all four files. The tag must equal `v` + the `package.json` version.                                                          | review; first real run on GitHub                                  |
| I14 | `GET /healthz` answers 200 `{"status":"alive"}` while the process serves requests. `GET /readyz` answers 200 `{"status":"ready"}` when the database answers and every committed migration is applied, otherwise 503 `{"status":"not-ready"}`. Neither needs sign-in or is sent to `/setup`.                                               | `readiness.test.ts`, `setup.test.ts`                              |

## 4. Paths

These never collide with the agent (`/opt/bmuster`, `/var/lib/bmuster`, `C:\Program Files\BMuster`, `C:\ProgramData\BMuster`), so a server can also be a managed machine.

|              | Linux                                                 | Windows                                                                |
| :----------- | :---------------------------------------------------- | :--------------------------------------------------------------------- |
| Program      | `/opt/bmuster-server` (root, 0755)                    | `C:\Program Files\BMuster Server`                                      |
| Data         | `/var/lib/bmuster-server` (`bmuster-server`, 0700)    | `C:\ProgramData\BMuster Server` (SYSTEM, Administrators, LocalService) |
| Settings     | `<data>/server.env` (0600)                            | `<data>\server.env`                                                    |
| Database     | `<data>/bmuster.db`                                   | `<data>\bmuster.db`                                                    |
| Agent builds | `<program>/releases/<version>/<target>/bmuster-agent` | `<program>\releases\<version>\<target>\bmuster-agent.exe`              |
| Service      | `bmuster-server.service`, user `bmuster-server`       | `BMusterServer` ("BMuster Server"), `NT AUTHORITY\LocalService`        |
| Log          | journald: `journalctl -u bmuster-server`              | `<data>\server.log` (moved to `server.log.old` above 10 MB)            |

## 5. Archive layout

`bmuster-server-<platform>.tar.gz` (Linux) or `.zip` (Windows), one top folder:

```
bmuster-server/
  bmuster-server[.exe]      the launcher
  VERSION                   the server version (package.json)
  LICENSE
  node/                     Node runtime: bin/node (Linux) or node.exe (Windows), its LICENSE
  app/                      a plain Node app, runnable without the launcher
    server.js               server.ts bundled (Vite SSR build; node_modules stay external)
    build/                  adapter-node output
    node_modules/           production dependencies for this platform
    package.json            name, version, "type": "module"
    src/lib/server/database/migrations/   applied at start-up (path relative to app/)
  releases/<version>/<target>/bmuster-agent[.exe]   all three agent builds (RELEASES_PATH)
```

Asset names carry no version (`bmuster-server-linux-x64.tar.gz`), so the installers fetch `https://github.com/jackbrumley/bmuster/releases/latest/download/<name>` with no GitHub API call (no rate limit, no JSON parsing). `SHA256SUMS` sits beside them; a specific release is `--version vX.Y.Z`.

`app/` and `releases/` are deliberately self-contained so a later Dockerfile can copy them as they are and run `node server.js` in `app/` with `RELEASES_PATH` pointing at the agents; the launcher is optional.

## 6. Port and TLS default

A fresh install listens on **8443** in **local network mode** (`BMUSTER_LOCAL_NETWORK_MODE=on`), so the address is `https://<host-ip>:8443`.

- **Why HTTPS out of the box:** session cookies are `Secure` (SPEC-SIGN-IN S5), so over plain HTTP to a LAN address nobody can sign in, and the desktop viewer needs a secure context (WebCodecs, clipboard). A new Pi or VM has no domain and no reverse proxy, so the server's own certificate (SPEC-INSTALL-OPTIONS L4) is the only thing that works with no extra steps. The browser warns once; agents get the pin from Add machine.
- **Why 8443:** the well-known alternative HTTPS port; 443 is often taken (or wanted by a reverse proxy) and needs privileges. `--port` picks another on first install; the unit allows ports below 1024, so 443 works too.
- **Why a first-run switch:** local network mode is a database setting. The switch applies only while there are no users, so after setup Settings → Security owns it, and turning it off for a reverse proxy sticks.
- **Behind a domain:** turn local network mode off in Settings, restart, and put a reverse proxy with a public certificate in front of `http://<host>:8443`. `ORIGIN` can be added to `server.env` if the proxy does not pass the host.

## 7. Launcher commands

| Command                                                                                  | What it does                                                                                                                                                                                                                                                                                                           |
| :--------------------------------------------------------------------------------------- | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bmuster-server run [--data-dir <dir>]`                                                  | Foreground (and the Linux service). Needs `server.env` in the data folder.                                                                                                                                                                                                                                             |
| `bmuster-server install [--prefix <dir>] [--data-dir <dir>] [--port <n>] [--no-service]` | Root or Administrator unless `--no-service`. Stops a running service, copies the bundle into the program folder (`<prefix>.new` then swapped in), creates the data folder and `server.env` if missing, creates the system user (Linux), writes and starts the service. `--port` applies only when `server.env` is new. |
| `bmuster-server uninstall [--prefix <dir>] [--data-dir <dir>] [--purge]`                 | Removes the service and program folder; keeps the data unless `--purge`.                                                                                                                                                                                                                                               |
| `bmuster-server status [--prefix <dir>] [--data-dir <dir>]`                              | Version, folders, service state, port and log location.                                                                                                                                                                                                                                                                |
| `bmuster-server --version`                                                               | The launcher's version.                                                                                                                                                                                                                                                                                                |

`server.env` holds `SECRETS_KEY`, `HOST`, `PORT` and `BMUSTER_LOCAL_NETWORK_MODE`, plus anything the admin adds (`ORIGIN`, `BMUSTER_ADMIN_EMAIL` …). `DATABASE_PATH` and `RELEASES_PATH` are always set by the launcher, so a moved prefix or data folder cannot drift from the file.

## 8. Upgrade and uninstall

- **Upgrade:** run the same one-line command. `install` stops the service, swaps the program folder for the new one, keeps `server.env` and the database, and starts the service; migrations run at start-up (additive only, AGENTS.md §3). The agent builds in `releases/` are the ones shipped with that server version.
- **Uninstall (Linux):** `sudo /opt/bmuster-server/bmuster-server uninstall [--purge]`.
- **Uninstall (Windows):** `& "C:\Program Files\BMuster Server\bmuster-server.exe" uninstall [--purge]` as Administrator. The running launcher cannot delete its own file, so it removes everything else and a short detached `cmd` removes the folder a few seconds later.
- Enrolled agents are not touched by either.

## 9. Testing

- Unit: the unit file text (`service_linux::tests`), the Windows service settings (`service_windows::tests`, compiled and linted for `x86_64-pc-windows-gnu`), `server.env` text and reading, Node command line, bundle swap; server: I12 and I14.
- Manual, no root: `npm run release:server-local`, then `sh docs/install.sh --archive dist/release/bmuster-server-linux-x64.tar.gz --prefix <scratch>/opt --data-dir <scratch>/data --no-service --port 47620`, `run`, `/readyz`, `/setup`, an agent download from `/agent/v1/releases/…`, stop, `uninstall --purge` on the scratch folders.
- Not testable here: Windows, arm64, the systemd service itself (needs root), and the release workflow (runs only on GitHub).

## 10. Out of scope

- The Docker image (later; section 5 keeps the layout ready for it).
- macOS servers, 32-bit Raspberry Pi OS, musl (Alpine) and Windows on Arm.
- Signing the archives (agent update signing is SPEC-AGENT-UPDATES), automatic server updates, and `admin:reset` from an installed server (it still needs a source checkout).
- Opening Linux firewalls (ufw, firewalld); the installer says which port to open.
- Moving an existing source install's data into `/var/lib/bmuster-server`.

## 11. As built

- **Server (I12, I14).** `env.ts` reads `BMUSTER_LOCAL_NETWORK_MODE` (`on` or unset; anything else stops start-up) as `localNetworkModeAtFirstRun`; it is listed in `.env.example`. `applyFirstRunLocalNetworkMode` (`services/auth/setup.ts`) runs first in the `init` hook, before the served certificate is chosen. It writes the setting through the new `updateSettingAsSystem` (`settings.ts`, sharing one write-and-audit path with `updateSetting`), audited as `setting-changed` with the system as actor and `source: BMUSTER_LOCAL_NETWORK_MODE`; `updated_by` is `system`. `/healthz` and `/readyz` are `route.public` endpoints with `cache-control: no-store`; readiness (`database/readiness.ts`) compares the rows in `__drizzle_migrations` with the entries in the migrations journal and logs the reason for a 503 to standard error. `needsSetupRedirect` leaves both alone.
- **Shared crate.** `agent/crates/service` (`bmuster-service`): `systemd::{require_root, require_systemd, systemctl, Unit}`, `windows::{known_folder, manager, require_admin, ServiceSpec, Account, service_info, failure_actions, create_and_start, exists, stop, start, stop_and_delete, state, restrict_dir, status}` and `log_file::open_rotated`. The agent now uses it; its names, paths, account (LocalSystem) and behaviour are unchanged.
- **Launcher.** `agent/crates/server` (`bmuster-server`): `layout.rs` (folders, bundle check), `config.rs` (`server.env`), `node.rs` (the Node command), `bundle.rs` (staged swap), `address.rs` (the LAN address from a UDP socket's source address; nothing is sent), `service_linux.rs`, `service_windows.rs`. On Linux `run` replaces itself with Node (`exec`). On Windows the service starts Node with its output appended to `server.log`, kills it on Stop (Windows has no SIGTERM for a console-less child; SQLite's write-ahead log keeps the database whole), and exits without reporting "stopped" when Node dies, so the failure actions restart it. `install` re-creates the Windows service on every run so its arguments follow the folders. `uninstall` refuses to delete a program folder that is not a bundle, or with `--purge` a data folder with neither `server.env` nor `bmuster.db`; the system user is removed only when running as root.
- **Archive script.** `npm run release:server-local` is `scripts/release-server.ts`; the agent target and version helpers it shares with `agent:release-local` are in `scripts/agent-build.ts`. `npm ci --omit=dev --ignore-scripts` (better-sqlite3 ships prebuilt binaries), then `node_modules/.bin`, better-sqlite3's sources and other platforms' prebuilds are removed. The Vite build runs with an in-memory `DATABASE_PATH`. Node archives are cached in `dist/cache`. A local linux-x64 archive is about 58 MB (Node 26 alone is 144 MB unpacked).
- **Installers.** `install.sh` is POSIX `sh` (clean under `shellcheck -s sh` 0.11 and `dash -n`). Both take `--archive` (checked against a `SHA256SUMS` beside it when there is one). Readiness is probed on `127.0.0.1` with `curl -k` (HTTPS, then HTTP), because nothing can vouch for the server's own certificate yet and the probe sends nothing secret. The setup code is read from `journalctl -u bmuster-server --since @<start>` or from the part of `server.log` written after the install began, so an old code is never shown. `install.ps1` uses `curl.exe` (Windows 10 1803+) for the probe, throws instead of exiting so `irm | iex` never closes the window, and takes PowerShell-style options (`-Port`, `-NoService`, …).
- **Workflow.** Jobs: `check` (tag equals `v` + package.json version), `binaries` (Linux through `cargo zigbuild` with ziglang 0.17.1 and cargo-zigbuild 0.24.1 against glibc 2.31, with an `objdump` check of the floor; Windows with MSVC), `package` (native runners, `npm ci --ignore-scripts`), `sums`, `install-test-linux` and `install-test-windows` (install, readiness, upgrade keeps the secrets key, uninstall `--purge`), then `publish` (tags only), which creates the release with every file at once.
- **Tests.** `env.test.ts`, `setup.test.ts` (I12, probe paths), `readiness.test.ts` (I14); Rust: `bmuster-service` (`systemd`, `windows`, `log_file`), `bmuster-server` (`layout`, `config`, `node`, `bundle`, `address`, `service_linux`, `service_windows`). The Windows tests of both crates were run under Wine (`x86_64-pc-windows-gnu`); the Windows code was linted with clippy for that target. The manual run of section 9 passed on linux-x64: install, `/readyz`, `/healthz`, `/setup` and finishing setup with the printed code, an agent download matching its SHA-256, an upgrade that kept the data and printed no new code, `uninstall`, `uninstall --purge`, and the refusal to delete a non-bundle folder.

## 12. Open questions

None.

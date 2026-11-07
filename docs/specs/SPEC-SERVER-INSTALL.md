# SPEC-SERVER-INSTALL: Installing the server with one command

**Status:** `APPROVED` (design approved by Jack 2026-11-07) · **Date:** 2026-11-07

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

| #   | Criterion                                                                                                                                                                                                                                                                                                                                 | Test                                                 |
| :-- | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :--------------------------------------------------- |
| I1  | `npm run release:server-local` builds this computer's archive in `dist/release/`: server build, bundled `server.ts`, production `node_modules`, migrations, pinned Node, this computer's agent and the launcher.                                                                                                                          | manual (section 9)                                   |
| I2  | `bmuster-server install` copies the bundle it was run from into the program folder (replacing an older one), creates the data folder, writes `server.env` once (new `SECRETS_KEY`) and keeps it on later runs, then registers and starts the service.                                                                                     | `bundle::tests`, `config::tests`, manual             |
| I3  | `install --prefix <dir> --data-dir <dir> --no-service` does the same without root, a service or a system user, for tests and hand-run servers.                                                                                                                                                                                            | manual (section 9)                                   |
| I4  | `bmuster-server run` starts the bundled Node on `app/server.js` with `DATABASE_PATH` and `RELEASES_PATH` set from the data and program folders and `--env-file=<data>/server.env`; on Linux it replaces itself with Node.                                                                                                                 | `node::tests`, manual                                |
| I5  | Linux: the unit `bmuster-server.service` runs `run --data-dir /var/lib/bmuster-server` as the system user `bmuster-server`, restarts on failure, writes only the data folder, and may bind ports below 1024.                                                                                                                              | `service_linux::tests`                               |
| I6  | Windows: the service `BMusterServer` ("BMuster Server") runs `run --service` as `NT AUTHORITY\LocalService`, starts automatically, restarts after a failure, logs to `server.log` in the data folder, and has an inbound firewall rule for its port.                                                                                      | `service_windows::tests` (built and linted, not run) |
| I7  | `bmuster-server uninstall` removes the service (and firewall rule) and the program folder and keeps the data; `--purge` also deletes the data folder (and on Linux the system user).                                                                                                                                                      | manual                                               |
| I8  | `bmuster-server status` shows the server version, the folders, the service state, the address and where the log is.                                                                                                                                                                                                                       | manual                                               |
| I9  | `docs/install.sh` (POSIX `sh`) downloads the newest release archive for this machine (`x86_64` or `aarch64`), checks it against the release's `SHA256SUMS`, and runs `install`. Re-running it upgrades in place and keeps the data. `--version`, `--port`, `--prefix`, `--data-dir`, `--no-service` and `--archive <file>` are passed on. | `shellcheck`, manual (section 9)                     |
| I10 | `docs/install.ps1` does the same on Windows x64 (Windows PowerShell 5.1 and PowerShell 7).                                                                                                                                                                                                                                                | parse check when `pwsh` is available; not run        |
| I11 | At the end both installers wait for `/readyz`, then print the address to open and the first-run setup code from the log (SPEC-SIGN-IN S17), or say exactly how to read it.                                                                                                                                                                | manual (section 9)                                   |
| I12 | `BMUSTER_LOCAL_NETWORK_MODE=on`, while the server has no users, turns local network mode on at start-up before the listener is chosen (audited as a setting change by the system). Any other value stops start-up. With users it does nothing.                                                                                            | `setup.test.ts`, `env.test.ts`                       |
| I13 | `.github/workflows/release.yml` (tags `v*` and manual runs) builds the agents and launchers, then the three archives on native runners, writes `SHA256SUMS`, and on a tag publishes one GitHub release with all four files. The tag must equal `v` + the `package.json` version.                                                          | review; first real run on GitHub                     |
| I14 | `GET /healthz` answers 200 `{"status":"alive"}` while the process serves requests. `GET /readyz` answers 200 `{"status":"ready"}` when the database answers and every committed migration is applied, otherwise 503 `{"status":"not-ready"}`. Neither needs sign-in or is sent to `/setup`.                                               | `readiness.test.ts`, `setup.test.ts`                 |

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

## 11. Open questions

None.

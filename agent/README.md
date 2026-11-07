# BMuster agent

The program that runs on each managed machine. It enrols with a BMuster server using a join code, checks in on a timer with signed requests, and keeps a live socket open so the console can ask for a check-in or watch the machine's load. The contract is [`docs/specs/SPEC-ENROLMENT.md`](../docs/specs/SPEC-ENROLMENT.md).

## Layout

```
agent/
  Cargo.toml              workspace (AGPL-3.0-only, exact versions, small release build)
  crates/protocol/        wire types, request signing, shared test vectors (tests/vectors.json)
  crates/service/         systemd and Windows service plumbing shared by the agent and the server launcher
  crates/server/          the `bmuster-server` launcher (runs and installs the server, SPEC-SERVER-INSTALL)
  crates/desktop/         remote desktop (SPEC-DESKTOP): X11 and Windows capture and input, JPEG tiles, pacing, the notice bar; licences in NOTICE.md
  crates/agent/           the `bmuster-agent` binary
    src/client.rs         server URL, HTTP and socket channels, signed requests, clock-drift correction
    src/tls.rs            rustls set-up: trust store, pinned key (--pin-cert) or --insecure-dev-tls
    src/trust.rs          the current and announced certificate check (pin rollover)
    src/identity.rs       Ed25519 key, identity.json, enrolment
    src/inventory.rs      inventory, load and signed-in user (sysinfo)
    src/gpus.rs           graphics cards: /sys/class/drm and pci.ids on Linux, WMI on Windows
    src/worker.rs         `run`: the check-in loop
    src/launcher.rs       `launch`: runs the worker, switches versions, rolls back (SPEC-AGENT-UPDATES)
    src/updates.rs        trusted release keys, build checks, version folders, the worker's download
    release-key.pub       the project's release public key, built into every agent
    src/socket.rs         the live socket (own thread)
    src/local_page/       the local page on https://localhost:47500 (SPEC-AGENT-LOCAL)
    src/relocate.rs       moving to another server, and leaving before an uninstall
    src/totp.rs           the local page's 6-digit sign-in codes (RFC 6238)
    src/status.rs         connection state shared by the loop, the socket and the page
    src/service_linux.rs  systemd install and uninstall
    src/exec/             starting session processes: pseudo-terminals, pipes, process trees, and
                          transient systemd units for sessions (placement.rs, unit.rs; SPEC-SESSION-UNITS)
    src/sessions/         terminal, exec, files and desktop sessions; files_helper.rs runs files in a unit
    src/service_windows.rs  Windows service install, uninstall and service entry point
```

## Commands

| Command | What it does |
| :-- | :-- |
| `bmuster-agent install --url <server> --code <code> [--name <name>] [--pin-cert <pin>]` | Needs root or Administrator. Copies the binary into place, enrols, then installs and starts the service. |
| `bmuster-agent enrol --url <server> --code <code> [--name <name>] [--pin-cert <pin>] [--data-dir <dir>] [--insecure-dev-tls]` | Enrols only. Use it for development. |
| `bmuster-agent launch [--data-dir <dir>] [--insecure-dev-tls]` | The service entry point: the launcher. It runs the agent from `<data>/versions/current` and keeps it up to date. |
| `bmuster-agent run [--data-dir <dir>] [--insecure-dev-tls] [--sessions <mode>]` | The agent itself: the check-in loop, the live socket and the local page. Run by hand it does not update itself. `--sessions` (or `BMUSTER_SESSIONS`) says where terminal, command and files sessions run; see below. |
| `bmuster-agent rejoin --url <server> --code <code> [--name <name>] [--pin-cert <pin>] [--data-dir <dir>] [--insecure-dev-tls]` | Moves this machine to another server: enrols there first with a new key, then tells the old server it left. Needs root or Administrator for an installed agent; stops and restarts its service. |
| `bmuster-agent status [--data-dir <dir>]` | Shows the enrolment and the service state. It does not contact the server. |
| `bmuster-agent uninstall [--purge]` | Stops and removes the service and the binary. `--purge` also deletes the data folder (identity and key). |
| `bmuster-agent --version` | Prints the version. |

`--pin-cert sha256:<base64>` is for a server in local network mode (its own self-signed certificate; the pin is on Add machine). The agent then accepts only a server certificate whose public key has that SHA-256, for HTTPS and the live socket, and ignores the host name and issuer. The pin is saved in `identity.json` (`serverPin`), so `run` and the service need no flag. When the server announces a new certificate (`pin-update` on the live socket) the agent saves it as `nextPin` and switches to it only once a connection with it works.

Exit codes for `run`: `0` stopped, `1` error, `3` the server removed this machine (`revoked`), `4` restart (the local page's Restart, or after a move), `5` a checked update waits in `versions/incoming` (only under the launcher). The launcher starts the agent again for `4`, switches for `5`, and itself exits `3` for a removed machine; the systemd unit sets `RestartPreventExitStatus=3`, so a removed machine stays stopped. Started by hand, a restart re-executes the agent in place.

## Sessions outside the sandbox (Linux, SPEC-SESSION-UNITS)

The agent's own unit is hardened (read-only system and home folders, private `/tmp`, no new privileges). Terminal, command and files sessions therefore run as their own transient systemd services, started by the service manager with `systemd-run`, outside that sandbox: `bmuster-terminal-<session id>`, `bmuster-exec-<session id>` and `bmuster-files-<session id>` (`systemctl list-units 'bmuster-*'`). They have no hardening on purpose (an admin's session is full root) and `UMask=0022`. Desktop sessions stay in the agent's process.

| `--sessions` / `BMUSTER_SESSIONS` | Where sessions run |
| :-- | :-- |
| `in-process` (the default) | As the agent's own child processes, inside its sandbox. Development runs, tests, macOS and Windows. |
| `systemd` | Transient services of the system manager. The installed unit sets `Environment=BMUSTER_SESSIONS=systemd`. |
| `systemd-user` | Debug builds only: transient services of your own user manager (`systemd-run --user`), to try the path without root. |

The agent logs the mode when it starts and the unit name for each session.

**Existing installs keep their old unit** until reinstalled, and a reinstall also re-enrols the machine. To turn the mode on without reinstalling, once the machine runs an agent build with this change (an update from the server is enough; the launcher in `/opt/bmuster` passes the environment through), add a drop-in and restart:

```bash
sudo mkdir -p /etc/systemd/system/bmuster-agent.service.d
printf '[Service]\nEnvironment=BMUSTER_SESSIONS=systemd\n' | sudo tee /etc/systemd/system/bmuster-agent.service.d/sessions.conf
sudo systemctl daemon-reload
sudo systemctl restart bmuster-agent
```

(`sudo systemctl edit bmuster-agent` and the same two lines does the same.) Check it with `journalctl -u bmuster-agent | grep 'transient systemd services'`, then open a terminal and run `cat /proc/self/cgroup`: it shows `/system.slice/bmuster-terminal-<id>.service`. An older agent ignores the variable. `uninstall` does not remove the drop-in folder; remove `/etc/systemd/system/bmuster-agent.service.d` by hand afterwards.

To try it without root: `cargo run -p bmuster-agent -- run --data-dir ./dev-data --insecure-dev-tls --sessions systemd-user`. `cargo test -p bmuster-agent -- --ignored` runs commands in units of your user manager.

## Updates (SPEC-AGENT-UPDATES)

The launcher keeps `versions/current` and `versions/previous` in the data folder. When a check-in reply offers a newer build, the agent checks the signature over the version, target, size and SHA-256 before downloading, downloads it over its usual connection (the same certificate check or pin), checks the size and SHA-256, writes it to `versions/incoming` and exits `5`. The launcher checks it again with its own keys, switches, and gives the new version 120 s to check in; otherwise it switches back and records "rolled back". `update-state.json` holds the last update event, reported in every check-in. `status` shows the running and previous versions.

Trusted keys: `release-key.pub` (the project key) and, only if set when building, `BMUSTER_EXTRA_RELEASE_KEY` (base64 raw Ed25519 public key; development builds and self-builders). `BMUSTER_VERSION` at build time sets the version (default: Cargo's).

## Local page

`https://localhost:47500` on the machine itself (Wannon Beacon uses 47400). Sign in with the 6-digit code from the console (machine → Manage → Local page → Show local page code; admins). It shows the connection, the machine and the recent log, and can test the connection, check in now, restart, move to another server and uninstall. `/healthz` answers 200 or 503 without sign-in.

- Files in the data folder: `local-page.crt`, `local-page.key` (self-signed ECDSA P-256), `local-page.secret` (the TOTP secret, sent once to the server), `local-page.reported`.
- To open it to the network, write `local-page.json`: `{ "listen": "0.0.0.0:47500" }` and restart. BMuster does not change the firewall; open the port yourself.
- Development: `run --local-page-port 47591` serves it on loopback at that port.

Installed locations:

| | Linux | Windows |
| :-- | :-- | :-- |
| Binary | `/opt/bmuster/bmuster-agent` | `C:\Program Files\BMuster\bmuster-agent.exe` |
| Data (key, `identity.json`) | `/var/lib/bmuster` (0700, files 0600) | `C:\ProgramData\BMuster` (SYSTEM and Administrators only) |
| Service | `bmuster-agent.service` (systemd, root) | `BMusterAgent`, shown as "BMuster Agent" (LocalSystem) |
| Log | journald (`journalctl -u bmuster-agent`) | `C:\ProgramData\BMuster\agent.log` |

Set the log level with `BMUSTER_LOG=debug` (`error`, `warn`, `info` (the default), `debug` or `trace`).

## Run a development copy against a local server

```bash
cd agent
cargo run -p bmuster-agent -- enrol --url https://localhost:5173 --code XXX-XXX-XXX \
  --data-dir ./dev-data --insecure-dev-tls
cargo run -p bmuster-agent -- run --data-dir ./dev-data --insecure-dev-tls --local-page-port 47591
```

The dev server uses a self-signed certificate. Without the `--insecure-dev-tls` flag the agent refuses it. With the flag, the agent accepts any certificate and logs a loud warning. Never use it against a real server. To test certificate pinning instead, turn on local network mode in the dev server's Settings and enrol with the `--pin-cert` shown on Add machine (no `--insecure-dev-tls` on `enrol` or `run`). Plain `http://` works only for `localhost` and loopback addresses. `./dev-data` is git-ignored. To enrol again, delete it.

## Offer a release build from a local server

```bash
npm run agent:release-local
```

Builds the agent in release mode for this computer as version `<cargo version>-dev.<UTC time>` (every build its own version), signs it with the development key in `~/.config/bmuster-dev/release-dev-key.pem` (made on first use; `--key-file` for another), and copies it with its `.sig` to `RELEASES_PATH/<version>/<target>/` (from `.env`). The dev server's install scripts and Add machine serve it, and agents built this way take newer development builds as updates. Release agents never trust the development key. It prints the path and SHA-256.

`npm run agent:sign -- --target <triple> [--version <v>] [--key-file <pem>] <binary>` signs any build (the release workflow uses the `BMUSTER_RELEASE_SIGNING_KEY` secret instead of a file). `npm run agent:release-key -- --out <file>` makes a new project key pair; see its header before using it.

## Checks

```bash
cargo fmt --check
cargo clippy --all-targets -- -D warnings
cargo test
```

`cargo test -p bmuster-protocol --test vectors` reproduces the shared signing vectors. The server's `signing.test.ts` checks the same file.

To type-check the Windows code from Linux without a mingw toolchain, run this. It only type-checks; the result can't be linked.

```bash
CC_x86_64_pc_windows_gnu=gcc AR_x86_64_pc_windows_gnu=ar cargo check --target x86_64-pc-windows-gnu
```

The same with clippy, for the Windows-only code (service, WMI graphics cards, desktop capture and input):

```bash
CC_x86_64_pc_windows_gnu=gcc AR_x86_64_pc_windows_gnu=ar cargo clippy --target x86_64-pc-windows-gnu --all-targets -- -D warnings
```

### Desktop tests on a nested X server

`cargo test -p bmuster-desktop --test x11` captures from and types into a nested X server, never the real desktop. Each test starts its own server on a free display from `:90`, with its own cookie in its own Xauthority file, and refuses to run on your own `DISPLAY`, `:0` or `:1`. The server is headless, so `npm run verify` never opens a window:

- `BMUSTER_XVFB=<path to Xvfb>` runs that binary; otherwise `Xvfb` on `PATH` is used.
- With neither, the tests pass after one line, "X11 tests skipped: no headless X server".
- `BMUSTER_X_TESTS=xephyr` runs them on `Xephyr` instead, which opens a window on your desktop so you can watch. Only when you ask for it.
- `BMUSTER_SKIP_X_TESTS=1` skips them even when Xvfb is installed.
- `BMUSTER_TEST_X_DIR=<folder>` keeps each server's Xauthority and log there instead of in a temporary folder.
- To get Xvfb without installing it (no sudo): `apt download xvfb`, unpack it with `dpkg-deb -x <deb> <folder>`, and set `BMUSTER_XVFB=<folder>/usr/bin/Xvfb`.

The AltGr test also needs `setxkbmap`.

`BMUSTER_DESKTOP_DISPLAY` and `BMUSTER_DESKTOP_XAUTHORITY` point a debug build's desktop sessions at a nested server; release builds ignore both.

Encoder timing for one 1920×1080 frame (full, and with 5% changed): `cargo bench -p bmuster-desktop --bench tiles`.

The golden frames the browser's `frame.test.ts` reads live in `tests/fixtures/desktop-frames/` at the repository root; `cargo test -p bmuster-desktop --test frame_fixtures` checks them, and `BMUSTER_WRITE_FIXTURES=1` rewrites them after a deliberate format change.

A debug build encodes slowly. For frame-rate checks against a nested server, build the desktop crate optimised while keeping the overrides: `cargo build --config 'profile.dev.package.bmuster-desktop.opt-level=3' --config 'profile.dev.package.jpeg-encoder.opt-level=3'`.

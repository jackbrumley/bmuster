# BMuster agent

The program that runs on each managed machine. It enrols with a BMuster server using a join code, checks in on a timer with signed requests, and keeps a live socket open so the console can ask for a check-in or watch the machine's load. The contract is [`docs/specs/SPEC-ENROLMENT.md`](../docs/specs/SPEC-ENROLMENT.md).

## Layout

```
agent/
  Cargo.toml              workspace (AGPL-3.0-only, exact versions, small release build)
  crates/protocol/        wire types, request signing, shared test vectors (tests/vectors.json)
  crates/service/         systemd and Windows service plumbing shared by the agent and the server launcher
  crates/server/          the `bmuster-server` launcher (runs and installs the server, SPEC-SERVER-INSTALL)
  crates/agent/           the `bmuster-agent` binary
    src/client.rs         server URL, HTTP and socket channels, signed requests, clock-drift correction
    src/tls.rs            rustls set-up: trust store, pinned key (--pin-cert) or --insecure-dev-tls
    src/trust.rs          the current and announced certificate check (pin rollover)
    src/identity.rs       Ed25519 key, identity.json, enrolment
    src/inventory.rs      inventory, load and signed-in user (sysinfo)
    src/gpus.rs           graphics cards: /sys/class/drm and pci.ids on Linux, WMI on Windows
    src/worker.rs         `run`: the check-in loop
    src/socket.rs         the live socket (own thread)
    src/local_page/       the local page on https://localhost:47500 (SPEC-AGENT-LOCAL)
    src/relocate.rs       moving to another server, and leaving before an uninstall
    src/totp.rs           the local page's 6-digit sign-in codes (RFC 6238)
    src/status.rs         connection state shared by the loop, the socket and the page
    src/service_linux.rs  systemd install and uninstall
    src/service_windows.rs  Windows service install, uninstall and service entry point
```

## Commands

| Command | What it does |
| :-- | :-- |
| `bmuster-agent install --url <server> --code <code> [--name <name>] [--pin-cert <pin>]` | Needs root or Administrator. Copies the binary into place, enrols, then installs and starts the service. |
| `bmuster-agent enrol --url <server> --code <code> [--name <name>] [--pin-cert <pin>] [--data-dir <dir>] [--insecure-dev-tls]` | Enrols only. Use it for development. |
| `bmuster-agent run [--data-dir <dir>] [--insecure-dev-tls]` | The service entry point. It runs the check-in loop, the live socket and the local page. |
| `bmuster-agent rejoin --url <server> --code <code> [--name <name>] [--pin-cert <pin>] [--data-dir <dir>] [--insecure-dev-tls]` | Moves this machine to another server: enrols there first with a new key, then tells the old server it left. Needs root or Administrator for an installed agent; stops and restarts its service. |
| `bmuster-agent status [--data-dir <dir>]` | Shows the enrolment and the service state. It does not contact the server. |
| `bmuster-agent uninstall [--purge]` | Stops and removes the service and the binary. `--purge` also deletes the data folder (identity and key). |
| `bmuster-agent --version` | Prints the version. |

`--pin-cert sha256:<base64>` is for a server in local network mode (its own self-signed certificate; the pin is on Add machine). The agent then accepts only a server certificate whose public key has that SHA-256, for HTTPS and the live socket, and ignores the host name and issuer. The pin is saved in `identity.json` (`serverPin`), so `run` and the service need no flag. When the server announces a new certificate (`pin-update` on the live socket) the agent saves it as `nextPin` and switches to it only once a connection with it works.

Exit codes for `run`: `0` stopped, `1` error, `3` the server removed this machine (`revoked`), `4` restart (the local page's Restart, or after a move, under systemd). The systemd unit sets `RestartPreventExitStatus=3`, so a removed machine stays stopped. Started by hand, a restart re-executes the agent in place.

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

Builds the agent in release mode for this computer and copies it to `RELEASES_PATH/<version>/<target>/` (from `.env`), so the dev server's install scripts and the **Install manually** download on Add machine can serve it. It prints the path and SHA-256.

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

The same with clippy, for the Windows-only code (service, WMI graphics cards):

```bash
CC_x86_64_pc_windows_gnu=gcc AR_x86_64_pc_windows_gnu=ar cargo clippy --target x86_64-pc-windows-gnu --all-targets -- -D warnings
```

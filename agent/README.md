# BMuster agent

The program that runs on each managed machine. It enrols with a BMuster server using a join code, checks in on a timer with signed requests, and keeps a live socket open so the console can ask for a check-in or watch the machine's load. The contract is [`docs/specs/SPEC-ENROLMENT.md`](../docs/specs/SPEC-ENROLMENT.md).

## Layout

```
agent/
  Cargo.toml              workspace (AGPL-3.0-only, exact versions, small release build)
  crates/protocol/        wire types, request signing, shared test vectors (tests/vectors.json)
  crates/agent/           the `bmuster-agent` binary
    src/client.rs         server URL, TLS, signed HTTP, clock-drift correction
    src/identity.rs       Ed25519 key, identity.json, enrolment
    src/inventory.rs      inventory, load and signed-in user (sysinfo)
    src/worker.rs         `run`: the check-in loop
    src/socket.rs         the live socket (own thread)
    src/service_linux.rs  systemd install and uninstall
    src/service_windows.rs  Windows service install, uninstall and service entry point
```

## Commands

| Command | What it does |
| :-- | :-- |
| `bmuster-agent install --url <server> --code <code> [--name <name>]` | Needs root or Administrator. Copies the binary into place, enrols, then installs and starts the service. |
| `bmuster-agent enrol --url <server> --code <code> [--name <name>] [--data-dir <dir>] [--insecure-dev-tls]` | Enrols only. Use it for development. |
| `bmuster-agent run [--data-dir <dir>] [--insecure-dev-tls]` | The service entry point. It runs the check-in loop and the live socket. |
| `bmuster-agent status [--data-dir <dir>]` | Shows the enrolment and the service state. It does not contact the server. |
| `bmuster-agent uninstall [--purge]` | Stops and removes the service and the binary. `--purge` also deletes the data folder (identity and key). |
| `bmuster-agent --version` | Prints the version. |

Exit codes for `run`: `0` stopped, `1` error, `3` the server removed this machine (`revoked`). The systemd unit sets `RestartPreventExitStatus=3`, so a removed machine stays stopped.

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
cargo run -p bmuster-agent -- run --data-dir ./dev-data --insecure-dev-tls
```

The dev server uses a self-signed certificate. Without the `--insecure-dev-tls` flag the agent refuses it. With the flag, the agent accepts any certificate and logs a loud warning. Never use it against a real server. Plain `http://` works only for `localhost` and loopback addresses. `./dev-data` is git-ignored. To enrol again, delete it.

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

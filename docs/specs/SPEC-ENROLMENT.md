# SPEC-ENROLMENT: Join codes, enrolment, check-in and the live socket

**Status:** `IN PROGRESS` (approved 2026-11-07; see As built) · **Date:** 2026-11-07 · **Version target:** 0.2.0

## 1. Problem

The console shows made-up machines. To show real ones, a machine needs a way to join a server once and then report in, with nothing opened on its firewall and no secret that can be replayed.

**In scope:** join codes, install scripts, enrolment, signed agent requests, check-in with inventory, the agent's live socket, online and offline status, removing a machine, and the first Rust agent that does all of this on Linux and Windows.

**Out of scope (later specs):** terminal, desktop and file sessions (SPEC-SESSIONS); agent self-update and release signing (SPEC-AGENT-UPDATES); macOS install; users and sign-in (SPEC-SIGN-IN). Until sign-in exists, the console stays a single-admin development build.

## 2. Ideas taken from Wannon Beacon

Written fresh, no code copied: a single-use join code; an Ed25519 key pair made on the machine; every request signed by the agent; a launcher that runs a worker; a live socket for "check in now". Unlike Beacon, BMuster's agent will run commands, so the server signs session tickets the agent verifies (Section 6).

## 3. Acceptance criteria

| #   | Criterion                                                                                                                                                                                 | Test                                          |
| :-- | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :-------------------------------------------- |
| A1  | An admin makes a join code; it shows once, works once by default (up to 100 uses and 7 days when set for a roll-out), and expires after 60 minutes by default.                            | `join-codes.test.ts`                          |
| A2  | A join code can name machine groups; the enrolled machine joins them.                                                                                                                     | `join-codes.test.ts`                          |
| A3  | `GET /install.sh` and `/install.ps1` return a script that downloads the agent from this server, checks its SHA-256 and enrols with the given code.                                        | `install-scripts.test.ts`                     |
| A4  | `POST /agent/v1/enrol` with a valid code and public key creates a machine and returns its id and the server's public key; a used, expired or unknown code is refused with a plain reason. | `enrol.test.ts`                               |
| A5  | Every other agent request must carry a valid signature over method, path, timestamp and body hash; a wrong key, a stale timestamp (over 5 minutes) or a repeated timestamp is refused.    | `agent-auth.test.ts`                          |
| A6  | A check-in updates last-seen time, status figures and, when it changed, the inventory snapshot.                                                                                           | `check-in.test.ts`                            |
| A7  | The live socket opens with a signed upgrade request; while it is open the machine shows Online.                                                                                           | `agent-socket.test.ts`                        |
| A8  | A machine with no socket and no check-in for 3 intervals shows Offline with its last-seen time.                                                                                           | `machine-status.test.ts`                      |
| A9  | Removing a machine refuses its next request with `revoked`; the agent stops and says so in its log.                                                                                       | `revoke.test.ts`, agent `revoked` test        |
| A10 | The console's Machines and machine Overview pages show real machines instead of prototype data.                                                                                           | `machines-page.svelte.test.ts`                |
| A11 | The agent's signing matches the server byte for byte: shared test vectors pass in Rust and TypeScript.                                                                                    | `signing.test.ts`, `protocol::tests::vectors` |

## 4. Flow

```
Console (admin)            Server                                 Machine
  make join code ───────▶  join_codes (hash, expires, groups)
  copy install command
                                                          curl …/install.sh | sudo sh -s -- --code K7P-4QX-29M
                           GET /install.sh  ◀──────────────────────
                           GET /agent/v1/releases/latest?target=…  ◀── downloads, checks SHA-256
                           POST /agent/v1/enrol  ◀── { code, publicKey, hostname, os, target, version }
                           ──▶ { machineId, serverPublicKey, checkInSeconds }
                                                          service starts
                           POST /agent/v1/check-in  ◀── signed, every 60 s
                           GET  /agent/v1/socket    ◀── signed upgrade, kept open
```

## 5. Join codes

- 9 characters from `ABCDEFGHJKLMNPQRSTUVWXYZ23456789`, shown as `XXX-XXX-XXX`. The hyphens are optional when typed.
- Stored as a SHA-256 hash with: expiry (60 minutes by default, up to 7 days), uses allowed (1 by default, up to 100), uses so far, machine group ids, created by.
- Shown once, in the Add machine page.
- The code is in the shell history of the machine; single use and a short life are what make that acceptable.

## 6. Identity and signing

**Agent identity.** On first run the agent makes an Ed25519 key pair. The private key stays on the machine (Linux: file mode 0600 under `/var/lib/bmuster`, root only; Windows: `C:\ProgramData\BMuster`, ACL for SYSTEM and Administrators). The server stores only the public key.

**Signed requests.** Every request after enrolment carries:

```
Authorization: BMuster <machineId>:<timestampMs>:<base64 signature>
signature = Ed25519( "BMUSTER-REQ-1\n" + METHOD + "\n" + path + "\n" + timestampMs + "\n" + hex(sha256(body)) )
```

- The server accepts a timestamp within 5 minutes of its clock and greater than the last timestamp it accepted from that machine (stored per machine, so a captured request cannot be replayed).
- The agent corrects for clock drift using the server's `Date` header.
- The live socket's upgrade request is signed the same way (`GET`, empty body).

**Server identity.** The server has its own Ed25519 key pair, made on first start and kept in the database encrypted with `SECRETS_KEY`. Enrolment returns the public key; the agent stores it. Later, session tickets are signed with it, so an agent only opens a terminal or desktop the server asked for (SPEC-SESSIONS).

**Shared test vectors** for both signatures live in `agent/crates/protocol` and are repeated in `src/lib/server/services/agents/signing.test.ts`.

### 6.1 Wire details (both sides build against these)

- JSON is camelCase UTF-8. Public keys and signatures are standard base64 (with padding) of the raw 32 and 64 bytes.
- Success: HTTP 200 with the reply object as the body.
- Refusal: HTTP 400, 401, 404 or 409 with `{ "reason": <code>, "message": <plain sentence> }`. Codes: `bad-request`, `invalid-code`, `expired-code`, `used-code`, `bad-signature`, `stale-timestamp`, `replayed-timestamp`, `unknown-machine`, `revoked`. On `revoked` the agent stops; on the others it logs and retries with back-off.
- The signed `path` is the URL path only, without query string, exactly as sent.
- Test vectors: `agent/crates/protocol/tests/vectors.json` (key from a fixed seed, two signed requests). Both sides' tests reproduce them.
- Enrol request: `{ code, publicKey, hostname, name, osFamily, target, agentVersion }` (`name` is `--name` or the hostname). Reply: `{ machineId, serverPublicKey, checkInSeconds }`.
- Release manifest (`GET /agent/v1/releases/latest?target=…`): `{ version, target, size, sha256, url }`; binaries live under `RELEASES_PATH/<version>/<target>/bmuster-agent[.exe]`.

### 6.2 Agent commands

- `bmuster-agent install --url <server> --code <code> [--name <name>]`: copies itself into place, enrols, writes and starts the service. Needs root or Administrator. The install scripts download, check the SHA-256 and run this.
- `bmuster-agent run [--data-dir <dir>]`: the service entry point. `--data-dir` lets a developer run an unprivileged copy (default: `/var/lib/bmuster` or `C:\ProgramData\BMuster`).
- `bmuster-agent enrol --url <server> --code <code> [--name <name>] [--data-dir <dir>]`: enrol only (for development).
- `bmuster-agent status [--data-dir <dir>]`, `bmuster-agent uninstall [--purge]`, `bmuster-agent --version`.

## 7. Check-in and inventory

`POST /agent/v1/check-in`, every `checkInSeconds` (60 by default; the server can change it in the reply).

Request (camelCase JSON):

```
{
  agentVersion, uptimeSeconds,
  signedInUser: { kind: 'none' } | { kind: 'user', name },
  load: { cpuPercent, memoryUsedBytes },
  inventory: { kind: 'unchanged', hash } | { kind: 'full', hash, data: Inventory }
}

Inventory = {
  os: { family, name, version, build, updatesPending },
  hostname, cpu: { model, cores }, memoryTotalBytes,
  disks: [{ mount, sizeBytes, usedBytes }],
  displays: [{ index, width, height, primary }],
  network: [{ name, mac, addresses }]
}
```

- The agent sends the full inventory on its first check-in after start and whenever its hash changes; otherwise `unchanged`.
- Reply: `{ checkInSeconds, inventoryWanted }`. When `inventoryWanted` is true the agent sends the full inventory on its next check-in, even if the hash is unchanged (the server has none, or a different one). Later specs add an update offer.
- `updatesPending`: Windows Update API on Windows; `apt`/`dnf` counts on Linux where available, else omitted as `{ kind: 'unknown' }` (to be modelled in the schema).

## 8. Live socket

`GET /agent/v1/socket`, signed upgrade, kept open with pings every 30 seconds.

- Server → agent: `{ type: 'check-in-now' }`, `{ type: 'watch', intervalMs }`, `{ type: 'unwatch' }`. Later: `session-open`.
- Agent → server: `{ type: 'live', cpuPercent, memoryUsedBytes }` every `intervalMs` while watched (a console page is open on that machine).
- The agent reconnects with back-off (1 s doubling to 60 s).
- Online = socket open, or a check-in within 3 intervals.

## 9. Removing a machine

- Admin removes a machine from its page (confirmAction). The row is marked removed, not deleted, so the audit log keeps its name.
- The next signed request gets `401 { reason: 'revoked' }`; the socket is closed with the same reason.
- The agent stops its worker, logs the reason, and stays installed but idle. `bmuster-agent uninstall` removes it.

## 10. Schema (additive)

| Table               | Columns                                                                                                                                               |
| :------------------ | :---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `machines`          | id, name, hostname, os_family, target, agent_version, public_key, last_request_ms, check_in_seconds, enrolled_at, last_seen_at, removed_at (nullable) |
| `machine_status`    | machine_id, signed_in_user (json), cpu_percent, memory_used_bytes, uptime_seconds, updated_at                                                         |
| `machine_inventory` | machine_id, hash, data (json), updated_at                                                                                                             |
| `join_codes`        | id, code_hash, machine_group_ids (json), max_uses, uses, created_by, created_at, expires_at                                                           |
| `server_keys`       | id, public_key, private_key_encrypted, created_at                                                                                                     |

The `machines` table from the prototype schema is replaced; nothing uses it yet.

## 11. Routes

| Method | Path                                    | Guard                                     |
| :----- | :-------------------------------------- | :---------------------------------------- |
| GET    | `/install.sh`, `/install.ps1`           | public                                    |
| GET    | `/agent/v1/releases/latest?target=…`    | public (manifest: version, size, SHA-256) |
| GET    | `/agent/v1/releases/[version]/[target]` | public (the binary is not secret)         |
| POST   | `/agent/v1/enrol`                       | public + join code in body                |
| POST   | `/agent/v1/check-in`                    | agent signature                           |
| GET    | `/agent/v1/socket`                      | agent signature (WebSocket)               |
| POST   | `/api/join-codes`                       | admin                                     |
| DELETE | `/api/machines/[id=uuid]`               | admin                                     |

Until SPEC-SIGN-IN lands, "admin" is the development single admin.

## 12. The agent (Rust)

```
agent/
  Cargo.toml                workspace
  crates/protocol/          request and reply types, signing, test vectors
  crates/agent/             `bmuster-agent`: launcher and worker in one binary
```

- Commands: `enrol --url --code`, `run` (the service), `launch` (the launcher), `status`, `uninstall`, `--version`.
- Linux: systemd unit, binary in `/opt/bmuster`, data in `/var/lib/bmuster`, logs to journald. Runs as root (it must later start shells and reach the display).
- Windows: service "BMuster Agent" as LocalSystem, binary in `C:\Program Files\BMuster`, data and logs in `C:\ProgramData\BMuster`.
- Crates (proposed): `reqwest` (rustls), `tungstenite`, `ed25519-dalek`, `sha2`, `serde`/`serde_json`, `sysinfo`, `clap`, `windows-service`.
- Release builds for `x86_64-unknown-linux-gnu`, `aarch64-unknown-linux-gnu`, `x86_64-pc-windows-msvc`. The server serves them from a `releases/` folder; signing comes in SPEC-AGENT-UPDATES.

## 13. Decisions (2026-11-07)

1. **Display name:** the install script takes an optional `--name`; without it the machine is named after its hostname. Admins can rename it in the console.
2. **Reusable codes:** single use is the default. For roll-outs an admin may set up to 100 uses and up to 7 days; every use is audited.
3. **First Linux targets:** Debian/Ubuntu and Fedora/RHEL families with systemd, on x86_64 and aarch64.

## 14. As built (2026-11-07)

Tested end to end on Linux: the Rust agent enrolled against a dev server, checked in with its real inventory, kept its live socket open, streamed figures while the machine page was open, and stopped with exit code 3 when the machine was removed.

| #          | State                                                                                                                                                            |
| :--------- | :--------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A1, A2     | Done. Machine groups are stored on the code; joining them waits for the access model.                                                                            |
| A3         | Done (`install-scripts.test.ts`, `releases.test.ts`). Not yet run on a real systemd or Windows machine.                                                          |
| A4–A9, A11 | Done, with the tests named above (`machine-views.test.ts` covers A7 and A8).                                                                                     |
| A10        | Machines and Overview show real data. **Not yet:** a Remove button (needs the shared `confirmAction` dialog); removal works through `DELETE /api/machines/<id>`. |

Differences from the text above:

- The check-in reply also carries `inventoryWanted` (Section 7).
- Upgrade refusals on the socket carry the same JSON `{ reason, message }` body as HTTP refusals; removal closes the socket with code 4001 and reason `revoked`.
- `join_codes` has no `created_by` yet; it is added with SPEC-SIGN-IN.
- The agent reports displays as an empty list and updates as `unknown` for now; Windows reports no signed-in user until the WTS API is used.
- Release binaries are read into memory when served (a few MB); streaming can come with release signing.
- The console has no accounts yet: the server refuses to start unless `CONSOLE_AUTH=none-development`. Never expose such a build.

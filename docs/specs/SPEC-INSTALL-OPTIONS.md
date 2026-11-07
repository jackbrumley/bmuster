# SPEC-INSTALL-OPTIONS: Manual install and local network mode

**Status:** `IN PROGRESS` · approved 2026-11-07 · Part 1 (M1–M5) built; Part 2 (local network mode) not built.

## Part 1: Manual install (always available)

### Why

The one-line `curl … | sudo sh` (or `irm … | iex`) does not suit every machine: deployment tools (Intune, Group Policy, Ansible) push a file and run a command; locked-down Windows blocks piped scripts; some machines have no curl or sit behind proxies; offline networks need a USB stick; careful admins want to inspect the file first.

### Acceptance criteria

| #   | Criterion                                                                                                                                                                                                                                                                                                                              | Test                         |
| :-- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :--------------------------- |
| M1  | Add machine has a collapsed **Install manually** section under the one-line command, for every OS tab.                                                                                                                                                                                                                                 | `add-machine.svelte.test.ts` |
| M2  | It offers **Download agent** for the chosen OS (version, size and SHA-256 shown) from `/agent/v1/releases/<version>/<target>`. With no build on the server it says so plainly.                                                                                                                                                         | `add-machine.svelte.test.ts` |
| M3  | It shows the one command to run beside the downloaded file, with the server address and join code filled in (and the certificate pin in local network mode). Linux: `chmod +x bmuster-agent && sudo ./bmuster-agent install --url … --code …`. Windows: `.\bmuster-agent.exe install --url … --code …` in PowerShell as Administrator. | `add-machine.svelte.test.ts` |
| M4  | A "For deployment tools" note explains using one download and a roll-out join code (up to 100 machines, 7 days), with a control to make one.                                                                                                                                                                                           | `add-machine.svelte.test.ts` |
| M5  | `npm run agent:release-local` builds the agent in release mode for this computer's target and copies it to `RELEASES_PATH/<version>/<target>/`, so a dev server can offer downloads.                                                                                                                                                   | manual                       |

### As built (Part 1)

- Add machine is split into `add-machine.svelte` (join code, OS tabs, one-line command), `install-manually.svelte` (a native `<details>`, collapsed) and `rollout-code.svelte`; `+page.svelte` only passes the origin, the downloads and whether this is the dev server.
- `+page.server.ts` (admin guard) loads the newest build for each target with `agentDownload` (`services/agents/releases.ts`). The agent targets and the manual command moved to `src/lib/domain/machines/agent-release.ts`, so the page and the server share them.
- Linux offers x86_64 by default and aarch64 as an option; Windows offers `x86_64-pc-windows-msvc`. The **Download agent** link goes to `/agent/v1/releases/<version>/<target>` and shows the version and size; the SHA-256 is in a copy field. With no build it says "This server has no agent build for <target> yet." and, on the dev server only, to run `npm run agent:release-local`.
- The command beside the file appears once the page's join code exists; until then the section says to make one. macOS shows the section with "The macOS agent is not built yet."
- **For deployment tools:** the roll-out control offers 10, 25, 50 or 100 machines and 1 hour, 1 day or 7 days (presets inside the 1–100 uses and 1 minute–7 days limits of `POST /api/join-codes`, so no free-number field is needed), then shows the code, its expiry and the command with it.
- `npm run agent:release-local` (`scripts/agent-release-local.ts`) reads the version from `[workspace.package]` (or `[package]`) in `agent/Cargo.toml`, maps this computer to `x86_64-unknown-linux-gnu`, `aarch64-unknown-linux-gnu` or `x86_64-pc-windows-msvc`, runs `cargo build --release`, copies the binary to `RELEASES_PATH/<version>/<target>/` and prints the path and SHA-256.
- Tests: `src/routes/(console)/add/add-machine.svelte.test.ts` (M1–M4). M5 was checked by hand against a scratch `RELEASES_PATH`.

## Part 2: Local network mode (self-signed certificate)

### Why

Some people want BMuster only inside their home or office network, with no domain and nothing public. That means a certificate no browser or agent trusts by default.

### Acceptance criteria

| #   | Criterion                                                                                                                                                                                                                                                            | Test                                            |
| :-- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :---------------------------------------------- |
| L1  | A server setting **Local network mode** (Settings → Security), off by default.                                                                                                                                                                                       | `settings.test.ts`                              |
| L2  | Turning it on opens a confirmation explaining: the server uses its own certificate; browsers warn the first time; use only on a network you control, never exposed to the internet; agents trust only this server's certificate. The admin must tick "I understand". | `local-network-mode.svelte.test.ts`             |
| L3  | While on, every console page shows a thin banner: "Local network mode: self-signed certificate".                                                                                                                                                                     | `shell-frame.svelte.test.ts`                    |
| L4  | In this mode the server serves HTTPS itself with a certificate it makes and keeps (10 years, its LAN names and addresses as subject names), so no reverse proxy is needed.                                                                                           | `local-tls.test.ts`                             |
| L5  | Install commands (one-line and manual) include `--pin-cert sha256:<fingerprint>`; the agent then accepts exactly that certificate and nothing else, for HTTPS and the live socket. The fingerprint is shown on Add machine for checking against the browser.         | `install-scripts.test.ts`, agent `pinning` test |
| L6  | The one-line install script, in this mode, downloads with the pin as well (curl `--pinnedpubkey`; PowerShell checks the certificate hash).                                                                                                                           | `install-scripts.test.ts`                       |
| L7  | Before the certificate changes (renewal, or turning the mode off for a public certificate), the server sends every agent the new pin, or "use normal checking", over its existing trusted connection; agents switch only after confirming the new certificate works. | `pin-rollover.test.ts`                          |
| L8  | Agents never have a "trust any certificate" option outside `--insecure-dev-tls` on `enrol` and `run` for development. Turning the mode on or off is audited.                                                                                                         | review, `audit.test.ts`                         |

## Open questions

None.

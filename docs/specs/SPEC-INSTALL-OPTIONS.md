# SPEC-INSTALL-OPTIONS: Manual install and local network mode

**Status:** `APPROVED` (2026-11-07) · Build after SPEC-SIGN-IN, part 1 first.

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

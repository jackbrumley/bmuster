<h1 align="center">BMuster</h1>

<p align="center">Self-hosted remote desktop, terminal and inventory for every computer you look after.</p>

<p align="center">
  <a href="https://www.gnu.org/licenses/agpl-3.0.html"><img src="https://img.shields.io/badge/License-AGPLv3-blue.svg" alt="AGPL v3 License" /></a>
  <img src="https://img.shields.io/badge/Platform-Windows%20%7C%20Linux%20%7C%20macOS-4f46e5" alt="Platform" />
  <img src="https://img.shields.io/badge/Status-Early%20design-f59e0b" alt="Status: early design" />
</p>

> **Status:** early design. Nothing works yet. See [docs/concept.md](docs/concept.md).

BMuster rounds up your machines. You host one small server (a Docker container, or a Raspberry Pi). Each computer runs a small agent, installed with one command and a join code. The agent phones home over ordinary HTTPS, and from a web page you can:

- open a terminal on the machine (PowerShell, cmd or a shell), with no SSH server needed;
- see and control its desktop, on every screen;
- send and fetch files;
- later: see its inventory (OS and version, updates, disks, memory), who can reach it, and who connected when.

## Principles

- **Web traffic only.** Everything runs over HTTPS and WebSockets on port 443. No inbound ports on the machines.
- **Mobile first.** There are no native apps. The web console has to work well on a phone.
- **One installer for every machine.** A generic, signed agent plus a join code. Nothing is built per customer or per group.
- **Self-hosted.** Your server, your data.
- **Secure by default.** This tool runs commands on your machines, so it treats access as the main risk: strong sign-in, consent prompts and an audit log.

## Licence

BMuster is free software under the [GNU Affero General Public License v3.0](LICENSE).

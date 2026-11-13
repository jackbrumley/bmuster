<h1 align="center">BMuster</h1>

<p align="center">Self-hosted remote desktop, terminal and inventory for every computer you look after.</p>

<p align="center">
  <a href="https://www.gnu.org/licenses/agpl-3.0.html"><img src="https://img.shields.io/badge/License-AGPLv3-blue.svg" alt="AGPL v3 License" /></a>
  <img src="https://img.shields.io/badge/Platform-Windows%20%7C%20Linux-4f46e5" alt="Platform: Windows and Linux" />
  <a href="https://github.com/jackbrumley/bmuster/releases"><img src="https://img.shields.io/github/v/release/jackbrumley/bmuster" alt="Latest release" /></a>
</p>

> **Status:** in active development and used in production on Windows and Linux machines. Website: [bmuster.com](https://bmuster.com). Downloads: [Releases](https://github.com/jackbrumley/bmuster/releases).

BMuster rounds up your machines. You host one small server (a Docker container, or a Raspberry Pi). Each computer runs a small agent, installed with one command and a join code. The agent phones home over ordinary HTTPS, and from a web page you can:

- open a terminal on the machine (PowerShell, cmd or a shell), with no SSH server needed;
- see and control its desktop, on every screen;
- send and fetch files, and share the clipboard both ways;
- see its inventory (operating system, hardware, disks, GPUs and who is signed in);
- give someone outside your team a time-limited share link to one machine;
- decide who can reach which machines with users, groups and access rules, and see who connected when.

## Install

Install the server with one command on a Raspberry Pi, a virtual machine or a spare PC:

```sh
curl -fsSL https://bmuster.com/install.sh | sudo sh      # Linux
irm https://bmuster.com/install.ps1 | iex                 # Windows, PowerShell as administrator
```

Then open the address it prints, create your admin account, and add machines from the server's **Add machine** page. The server and agents update themselves from signed releases.

## Principles

- **Web traffic only.** Everything runs over HTTPS and WebSockets on port 443. No inbound ports on the machines.
- **Mobile first.** There are no native apps. The web console has to work well on a phone.
- **One installer for every machine.** A generic, signed agent plus a join code. Nothing is built per customer or per group.
- **Self-hosted.** Your server, your data.
- **Secure by default.** This tool runs commands on your machines, so it treats access as the main risk: strong sign-in, a notice on the machine during every session, and an audit log.

## Code signing

Free code signing provided by [SignPath.io](https://about.signpath.io/), certificate by [SignPath Foundation](https://signpath.org/). See the [code signing policy](https://bmuster.com/code-signing-policy). Releases up to 0.4.24 are not Authenticode signed.

Separately, every release is signed with the project's own Ed25519 key, and the server and agents refuse any update without a valid signature.

## Licence

BMuster is free software under the [GNU Affero General Public License v3.0](LICENSE).

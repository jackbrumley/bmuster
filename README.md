<p align="center">
  <img src="static/brand/icon-192.png" alt="" width="96" height="96" />
</p>

<h1 align="center">BMuster</h1>

<p align="center">Self-hosted remote access for every machine you look after.<br />Reach the desktop and terminal of your Windows and Linux machines from any browser, phone included, on a server you run yourself.</p>

<p align="center">
  <a href="https://github.com/jackbrumley/bmuster/releases/latest"><img src="https://img.shields.io/github/v/release/jackbrumley/bmuster?label=release&color=65a30d" alt="Latest release" /></a>
  <img src="https://img.shields.io/badge/platform-Windows%20%7C%20Linux-65a30d" alt="Windows and Linux" />
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-AGPL--3.0-65a30d" alt="AGPL-3.0" /></a>
</p>

<p align="center">
  <a href="https://bmuster.com/">Website</a> ·
  <a href="https://github.com/jackbrumley/bmuster/releases/latest">Downloads</a> ·
  <a href="docs/hosting.md">Hosting guide</a> ·
  <a href="https://github.com/jackbrumley/bmuster/issues">Report an issue</a>
</p>

## Install

Install the server on a Raspberry Pi, a virtual machine or a spare PC.

**Linux**

```bash
curl -fsSL https://bmuster.com/install.sh | sudo sh
```

**Windows** (PowerShell, run as administrator)

```powershell
irm https://bmuster.com/install.ps1 | iex
```

It installs BMuster as a service and shows the address to open. Create your admin account there, then add machines from the server's **Add machine** page: it gives a one-line command with a join code to run on each computer. The server and agents update themselves from signed releases.

## What it does

BMuster is one place to reach and look after a fleet of computers, from a handful to hundreds. You run the server; a small agent on each machine phones home over HTTPS, so there are no ports to open on the machines themselves.

- Remote desktop and terminal in the browser, built mobile-first so it works from your phone
- Unattended access, with a notice on the machine and a Disconnect button while someone is connected
- Inventory for every machine: hardware, operating system, GPUs and who is signed in
- Users, groups and access rules that decide who can reach which machines
- Sign in with a password, or with Microsoft 365 or Authentik, and an activity log of who did what
- Works on a private network too, with its own pinned certificate when there is no public domain

## Build from source

Needs the Node.js version in `.node-version` and, for the agent, Rust.

```bash
npm install
npm run dev        # run the server in development (HTTPS, reachable on your LAN)
npm run agent:dev  # build the agent and enrol it with the dev server
npm run build      # build the server
npm start          # run the built server
```

Contributor notes are in [AGENTS.md](AGENTS.md).

## Code signing

Free code signing provided by [SignPath.io](https://about.signpath.io/), certificate by [SignPath Foundation](https://signpath.org/) ([code signing policy](https://bmuster.com/code-signing-policy)). Every release is also signed with the project's own Ed25519 key, and the server and agents refuse any update without a valid signature.

## Support

BMuster is free and made by one person. If it saves you time, please consider a [small donation](https://bmuster.com/donate) through GitHub Sponsors or PayPal. Admins see a short reminder on the Machines page after a couple of weeks; it runs entirely on your server, sends nothing anywhere and never checks whether you donated.

## License

[GNU AGPLv3](LICENSE). Your machines, your server, your data.

---

<p align="center">
  BMuster is one of the free apps by <a href="https://brumley.info">Jack Brumley</a>:<br />
  <a href="https://voquill.org">Voquill</a> · <a href="https://brumley.info/rusty-g6/">Rusty G6</a> · <a href="https://somedrive.org/">SomeDrive</a> · <a href="https://yambuck.com/">Yambuck</a> · <a href="https://brumley.info/rawtap/">RawTap</a> · <b>BMuster</b>
</p>

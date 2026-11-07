# BMuster: Concept

Status: draft, 2026-11-07. Items marked **proposed** are not yet agreed.

## 1. What it is

One self-hosted server and one agent per computer. The server hosts a web console. Agents phone home over HTTPS and keep one WebSocket open. From the console you open sessions on any machine: terminal, desktop, files. Later the console also becomes an inventory and access-control system for every computer you look after.

Why build it: MeshCentral, RustDesk, TeamViewer and LogMeIn each fall short. MeshCentral builds a separate installer per group, has memory leaks and a dated UI. RustDesk has no inventory. No mature open-source tool combines a modern mobile-first web console, one generic installer, inventory, desktop, terminal and files on Windows, Linux and macOS over port 443 only. NetLock RMM (AGPL-3.0) comes closest but has no macOS remote screen.

## 2. Shape

```
Browser (mobile-first)  ⇄ HTTPS/WSS :443 ⇄  Server (Docker / Raspberry Pi)  ⇄ WSS (outbound) ⇄  Agent
  terminal · desktop · files                  console, relay, database              PTY · capture · input
```

- **Server:** serves the console, the install scripts and the agent binaries. It relays session traffic and never decodes it, so a Raspberry Pi can keep up. SvelteKit (adapter-node) with SQLite and Drizzle, one multi-arch Docker image (amd64 and arm64). The app lives at the repository root in `src/`.
- **Agent:** Rust, in `agent/` in the same repository. A launcher runs the worker, switches to new versions and rolls back a failed one. One control WebSocket; each session opens its own stream, so a busy desktop stream can't block control messages.
- **Transport:** HTTPS and WebSockets only, on 443. Optional peer-to-peer (WebRTC) may come later, never as a requirement.

## 3. Enrolment and identity

1. An admin creates a join code in the console (single use, short lived).
2. The install command (`curl … | sudo sh` on Linux and macOS, `irm … | iex` on Windows) downloads the generic agent from the server and enrols with `--url` and `--code`.
3. On first run, the agent makes an Ed25519 key pair and sends the public key with the join code. The server never issues a shared secret.
4. For each connection, the agent signs a short assertion and gets a short-lived token.
5. The agent pins the server's identity at enrolment.

Written fresh from the same ideas as Wannon Beacon; no Beacon code is copied (Beacon is not licensed for release).

## 4. Security model

This tool runs commands and controls desktops. Whoever controls the server controls every enrolled machine. So, from the first release:

- Console sign-in with passkeys or TOTP. No shared admin password.
- Per-machine setting: unattended access, or "ask the person at the screen" (accept or deny).
- Audit log: who opened which session on which machine, when, and of what kind.
- Agent updates are signed with a key kept off the server.

## 5. Features

### Terminal (first feature)

- Agent opens a PTY: ConPTY on Windows (PowerShell or cmd), a PTY on Linux and macOS (the user's shell).
- Browser shows it with xterm.js.
- Mobile: a row of extra keys (Ctrl, Alt, Esc, Tab, arrows, paste).

### Desktop

- Capture, encode to H.264, decode in the browser with WebCodecs, draw to a canvas.
- Windows: the service runs in Session 0, so it starts a helper in the active user session. The sign-in screen and UAC prompts need their own handling.
- Linux: X11 first. Wayland goes through the PipeWire screen-cast portal, and unattended use is limited.
- Mobile input: trackpad mode and direct-touch mode, plus a keyboard button.
- Screen picker and an all-screens view.

### Files

- Send and fetch files through the session, with progress and resume.

### Later

- **Inventory:** OS and version, update status, disks with size and use, average memory, hardware. The agent's check-in message carries room for this from day one.
- **Access:** who can reach which machine.
- **Share links:** short-lived links that anyone can use to reach one machine.
- **Audit:** full history of who connected to what and when.
- **Session recording.**
- **Clipboard sync.**
- **CSV export on every list:** machines, users, groups, access rules and activity, for audits and outside parties. Exports respect the viewer's access and are themselves audited.
- **Devices with no agent** (routers, PLCs): an agent on the same network scans and reports them.

## 6. Reuse and licences

| Source                    | Licence      | Use                                                           |
| ------------------------- | ------------ | ------------------------------------------------------------- |
| RustDesk                  | AGPL-3.0     | Code may be reused with notices kept.                         |
| RustDesk `scrap`, `enigo` | MIT          | Screen capture and input injection.                           |
| MeshCentral               | Apache-2.0   | Compatible one way into AGPL-3.0; mostly a feature checklist. |
| Wannon Beacon             | Not released | Ideas only.                                                   |

## 7. Decisions

1. Server stack: SvelteKit with SQLite and Drizzle in one Docker image (**decided**).
2. Beacon: rewrite from the ideas (**decided**).
3. First feature: terminal before desktop (**decided**).

# SPEC-AGENT-LOCAL: The agent's local page and moving servers

**Status:** `APPROVED` (design, 2026-11-07; not built) · **Date:** 2026-11-07

## 1. Problem

Someone at the machine (often the admin, on site) needs to see whether the agent is healthy, fix a broken connection, or move the machine to a different BMuster server, without the console and possibly without the internet. The idea comes from Wannon Beacon's on-site page; the code is written fresh.

## 2. The local page

- The agent serves `https://localhost:47500` (not 47400, which Wannon Beacon uses, so both can run on one machine) with a self-signed certificate it makes on first run. The console shows the certificate's SHA-256 fingerprint so the browser warning can be checked.
- **Localhost only by default.** A server setting can open it to the local network (for headless machines); the agent then also opens its firewall port, and closes it again on uninstall.
- **Sign-in with a 6-digit code** from the console: machine Overview → _Show local page code_ (admins only). The code changes every 30 seconds (RFC 6238 TOTP) from a secret the agent makes and sends once, inside a signed check-in. It works while the internet is down. 5 wrong codes pause sign-in for 5 minutes. A session lasts 1 hour from the last action.
- **Shows:** connected or not, server address, machine name and id, last check-in and last error, agent version and update state, CPU, memory, disks, the recent log.
- **Actions:**
  - _Test connection_: name lookup, network, HTTPS, signed check-in, each with a clear pass or fail.
  - _Check in now_.
  - _Restart the agent_.
  - _Move to another server_ (section 3).
  - _Uninstall the agent_ (with a confirmation): removes the service, the program and its identity, the same as `bmuster-agent uninstall --purge`, and tells the server it is leaving.
- `/healthz` answers without sign-in (200 healthy, 503 not), for monitoring.

## 3. Moving to another server

- From the local page: enter the new server's address and a join code from **its** Add machine page. The agent enrols with the new server first and only then tells the old server it is leaving (a signed `leave` request), so a typo never strands the machine.
- From the command line, as root or Administrator: `bmuster-agent rejoin --url <new server> --code <code>`, which does the same.
- The old server marks the machine _moved_ (not removed) in its audit log.

## 4. In the console (machine Overview, Agent panel)

Already built: the status, uninstall and uninstall-and-purge commands for the machine's system, with copy buttons.

To add:

- A **Local page** section: the address to open on the machine itself (`https://localhost:47500`, with a copy button), the certificate fingerprint to check the browser warning against, and **Show local page code** (admins): the current 6-digit code with a countdown to the next one. Viewing the code is audited.
- _Remove from this server_ (confirmation dialog): refuses the agent from now on; the agent stops.
- The `rejoin` command for moving servers.

## 5. Decisions (2026-11-07)

1. **Where it listens:** localhost only by default; the local network is an opt-in server setting.
2. **Who sees the code:** admins only for now.

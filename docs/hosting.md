# Hosting BMuster on Coolify behind Nginx Proxy Manager

A checklist for running BMuster from the container image on Coolify, behind Nginx Proxy Manager (NPM), at a name such as `https://bmuster.example.com`. Design and tests: [SPEC-HOSTING](specs/SPEC-HOSTING.md). For a plain server install instead, see the [install command](https://bmuster.com).

Placeholders used below:

| Placeholder           | Meaning                                                                   |
| :-------------------- | :------------------------------------------------------------------------ |
| `bmuster.example.com` | The public name BMuster will have.                                        |
| `<npm-ip>`            | The address NPM connects to Coolify from (NPM's own address on your LAN). |
| `<coolify-host>`      | The Coolify server's name or address, as NPM reaches it.                  |
| `<project>`, `<env>`  | The Coolify project and environment the resource goes in.                 |

## How it fits together

```text
Browser or agent ── HTTPS / WSS ──▶ NPM (<npm-ip>)
                                     TLS ends here (Let's Encrypt)
                                     adds X-Forwarded-For: <client>
        ── HTTP ──▶ Traefik on <coolify-host>:80 (Coolify's proxy)
                    routes by host name; once it trusts NPM, keeps NPM's headers
                    and adds X-Forwarded-For: <npm-ip>
        ── HTTP ──▶ BMuster container :8080 (network bmuster)
                    /data volume: bmuster.db, its lock, backups/
```

- **One image, one version.** `ghcr.io/jackbrumley/bmuster:vX.Y.Z` holds the server and the agent builds for that version, built by the release workflow from the same archives the installers use. Coolify pulls it by tag.
- **Who is asking.** The server reads the client's address from `X-Forwarded-For`, two hops from the right (`XFF_DEPTH=2`: NPM, then Traefik). It reads the public address (`https://bmuster.example.com`) from `X-Forwarded-Proto` and `X-Forwarded-Host`. Both need Traefik to trust NPM (section 3). Without that trust, sign-in fails on purpose: otherwise every client would share NPM's address and one sign-in limit.
- **One server at a time.** The server locks `/data/bmuster.db.lock` before it opens the database. During a deploy, Coolify starts the new container first. The new container waits on the lock (and logs why). The old one stops, then the new one migrates and starts serving. Traefik sends traffic only to healthy containers, so the switch is a gap of a few seconds.
- **Backups.** A backup of the host or volume copies `/data`, but a copy of a live SQLite file can catch a write half-done. So the server writes its own whole snapshot to `/data/backups/` each night; schedule it before your host backup runs.

## 1. Before the first deploy

1. **DNS:** point `bmuster.example.com` at the public address NPM answers on, the same way as your other proxied names.
2. **Secrets key:** run `openssl rand -base64 32` and save the result in your password manager **before** you paste it anywhere else.
   - It encrypts the server's signing key and sign-in provider secrets in the database. A restored database is useless without it, and enrolled agents would have to be re-enrolled.
   - It never changes after the first start.
3. **Image access:** the image is published at `ghcr.io/jackbrumley/bmuster` and is public, so Coolify pulls it without credentials. If you build and push your own copy, check that its GHCR package is public, or add a registry credential in Coolify: GHCR can make a new package private even when the repository is public.

## 2. Coolify

1. **Destination:** Servers → your server → Destinations → Add. Name `BMuster`, network `bmuster`. BMuster then shares no Docker network with your other apps. Coolify attaches Traefik to it by itself.
2. **Resource:** project `<project>`, environment `<env>` → New → **Docker Image**. Image `ghcr.io/jackbrumley/bmuster`, tag `vX.Y.Z` (the release you are deploying, e.g. `v0.2.0`). Pick the `BMuster` destination.
3. **General:**
   - Domains: `http://bmuster.example.com:8080`. This uses `http` because TLS ends at NPM, and `:8080` is the container port Traefik routes to.
   - Ports Exposes: `8080`. Leave **Ports Mappings empty**. A host port would bypass NPM and Traefik, and it turns off Coolify's rolling start.
4. **Persistent Storage:** add a volume. Name `bmuster-data`, destination path `/data`.
   - The image's `/data` belongs to the container user (`node`, uid 1000). A new named volume takes that owner.
   - A bind mount (host folder) must be owned by uid 1000.
5. **Environment variables:**

   | Variable              | Value                      | Why                                                                                                                          |
   | :-------------------- | :------------------------- | :--------------------------------------------------------------------------------------------------------------------------- |
   | `SECRETS_KEY`         | from your password manager | Required. Mark it as a secret in Coolify. Never change it.                                                                   |
   | `XFF_DEPTH`           | `2`                        | The image's default, set here so it is visible. Two trusted proxies: NPM, then Traefik. If NPM is ever removed, set `1`.     |
   | `TZ`                  | e.g. `Australia/Melbourne` | So the snapshot time and log times are local.                                                                                |
   | `BMUSTER_BACKUP_TIME` | e.g. `00:30`               | The nightly snapshot (HH:MM). Pick a time that finishes before your host backup, which then carries that night's whole copy. |
   | `BMUSTER_BACKUP_KEEP` | `14`                       | Optional (14 is the default). How many daily snapshots stay in `/data/backups`.                                              |

   Do **not** set these:
   - `ORIGIN`: this version of the server ignores it. The public address comes from the forwarded headers (section 3).
   - `BMUSTER_LOCAL_NETWORK_MODE`: that is the server's own HTTPS for a LAN with no proxy. Behind NPM it would break Traefik's plain-HTTP connection and the health check.
   - `PORT`, `DATABASE_PATH`, `RELEASES_PATH`: the image sets them.

6. **Healthcheck:** make sure Coolify's health check is **off**. The image has its own (`/readyz` with Node's `fetch`; the image has no curl or wget), and Traefik and Docker use it.
   - If Coolify's check is on, Coolify waits for the new container to be healthy before it stops the old one.
   - The new container cannot become healthy while the old one holds the lock, so the deploy fails after the retries. The old one keeps serving.
7. **Advanced:** leave **Consistent Container Name** off. If Coolify shows a rolling-update drain time, set it to `0`: the new container cannot take traffic until the old one stops anyway.
8. **Deploy.** Then open Logs. You should see:

   ```text
   BMuster first-run setup code: XXXX-XXXX-XXXX-XXXX — open /setup
   BMuster: a database snapshot is written to /data/backups every day at 00:30, keeping 14.
   BMuster listening on http://0.0.0.0:8080, holding /data/bmuster.db.lock
   ```

   - If the Logs tab has scrolled, read the code on `<coolify-host>`: `docker ps --filter name=<resource uuid>` for the container name, then `docker logs <container> 2>&1 | grep 'setup code'`.
   - A restart before setup prints a new code; use the newest one.

9. Do section 3 (Traefik) and section 4 (NPM), then open `https://bmuster.example.com/setup`, enter the code and create the first admin.
10. In **Settings → Security**, leave local network mode **off**.

## 3. Traefik must trust NPM

Out of the box, Coolify's Traefik trusts no proxy in front of it. It throws away NPM's `X-Forwarded-For`, `X-Forwarded-Proto` and `X-Forwarded-Host` and writes its own, so BMuster sees NPM as the client and `http` as the scheme. Then:

- sign-in fails, and the log shows `XFF_DEPTH is 2, but only found 1 addresses`;
- form posts may be refused with `Cross-site POST form submissions are forbidden`, because the server thinks it is `http://…` while the browser is on `https://…`.

To fix it, trust NPM's address on Traefik's `http` entry point:

1. Coolify → Servers → your server → Proxy → Configuration. Under `command:` of the `traefik` service, add:
   ```yaml
   - '--entrypoints.http.forwardedHeaders.trustedIPs=<npm-ip>/32'
   ```
   Only that address is trusted. A client that reaches Traefik some other way still gets its headers replaced.
2. Save, then **Restart Proxy**. Every Coolify app is unreachable for a few seconds, so do it at a quiet time.
3. **Check the setting is live:** on `<coolify-host>`, run
   `docker inspect coolify-proxy --format '{{join .Args "\n"}}' | grep forwardedHeaders`. It must print the line above.
4. **Check the effect:** sign in to BMuster from outside your network (e.g. a phone on mobile data). Open **Activity**. Your sign-in must show the phone's public address (search "what is my IP" on the phone to compare), not `<npm-ip>`.
   - If sign-in fails with the `XFF_DEPTH` error, Traefik still does not trust NPM. Check step 1. Also check that NPM reaches `<coolify-host>` from `<npm-ip>` without address translation by a router or firewall in between: Traefik must see that source address.

**Other apps on the same Coolify server:** the setting applies to every app behind Traefik.

- An app that counts one proxy (`XFF_DEPTH=1` or similar) still sees NPM's address, as before. Counting two would give it real client addresses too.
- Its `X-Forwarded-Proto` changes from `http` to NPM's `https`, which is the true scheme. Check that your other apps sign in normally after the proxy restart.

## 4. Nginx Proxy Manager

Add a proxy host:

1. **Details:**
   - Domain Names: `bmuster.example.com`
   - Scheme: `http`, Forward Hostname / IP: `<coolify-host>`, Forward Port: `80`
   - **Websockets Support: on.** Agents, terminals and desktops use WebSockets. Without it NPM drops the `Upgrade` header and nothing connects.
   - Cache Assets: off. The server sets its own cache headers.
   - Block Common Exploits: off. Its query-string patterns can match legitimate requests, and BMuster checks every request itself.
2. **SSL:** Request a new SSL Certificate. Use your DNS provider's DNS challenge (or HTTP-01 if port 80 reaches NPM from the internet).
   - Force SSL: on.
   - HTTP/2 Support: on.
   - HSTS Enabled: on.
   - HSTS Subdomains: off.
3. **Advanced → Custom Nginx Configuration:**
   ```nginx
   proxy_read_timeout 3600s;
   proxy_send_timeout 3600s;
   proxy_buffering off;
   client_max_body_size 0;
   ```
   NPM puts this inside the host's `server { }` block, so it applies to its `location /`.
   - `proxy_read_timeout 3600s`: how long NPM waits for the next bytes from BMuster before it closes the connection. NPM's default is 90 s. A quiet terminal, a desktop with nothing changing or an idle agent link can easily go longer, and each timeout would cut the session and force a reconnect.
   - `proxy_send_timeout 3600s`: the same limit in the other direction, while NPM sends to Traefik (default 90 s).
   - `proxy_buffering off`: nginx normally collects a response in memory (and in temporary files for large ones) before passing it on. Off, bytes go to the browser as they arrive: streamed responses are not held back, and agent downloads (several MB) do not touch NPM's disk. WebSockets are not buffered either way.
   - `client_max_body_size 0`: no request size limit at NPM. NPM's default is 2000 MB; nginx's own default is 1 MB. With no limit here, the server's own limit (`BODY_SIZE_LIMIT=16M` per request, with file transfers in 8 MB chunks) is the only one, so NPM can never cut off an upload.
4. Save. Open `https://bmuster.example.com/readyz`: it must answer `{"status":"ready"}`.

## 5. Backups and restore

- **What is captured:** the `bmuster-data` volume lives on the Coolify server (`/var/lib/docker/volumes/<name>/_data`), so a backup of that server or of its Docker volumes copies it.
- **What is consistent:** the live `bmuster.db` (with its `-wal` file) can be caught mid-write. `backups/bmuster-YYYY-MM-DD.db` is always whole: it is written with SQLite's backup API to a temporary name, then renamed. With `BMUSTER_BACKUP_TIME` before your host backup, each host backup holds that night's snapshot. The log says `database snapshot written to …`, or why it failed.
- **The lock files:** `bmuster.db.lock` and `bmuster.db.lock-journal` are the one-server lock. Leave them; they never go stale, because the kernel releases the lock when the server stops.
- **Restore:**
  1. Stop the resource in Coolify.
  2. In the volume folder, rename the current `bmuster.db`, `bmuster.db-wal` and `bmuster.db-shm` aside.
  3. Copy the chosen `backups/bmuster-YYYY-MM-DD.db` to `bmuster.db` and give it to uid 1000 (`chown 1000:1000`).
  4. Start the resource. `SECRETS_KEY` must be the one from your password manager.

## 6. Upgrading

1. Read the release notes on GitHub (`github.com/jackbrumley/bmuster/releases`).
2. In Coolify, change the image tag to the new `vX.Y.Z` and click Deploy.
   - Use exact version tags. `latest` and `X.Y` also exist, but with them Coolify cannot tell that anything changed, and the running version is not written down anywhere.
3. Watch the logs. The new container prints `another server is using /data/bmuster.db … Waiting`. The old one stops, the new one prints `the other server has stopped`, applies any migrations and starts listening.
4. The image carries the agents for its version, so Add machine hands out the new agents.
5. **Rolling back:** set the old tag and deploy. Migrations only ever add, so an older server normally runs on a newer database. If not, restore the snapshot from before the upgrade (section 5).

## 7. Locked out: host commands

Two commands get an admin back in. They run on the server's machine, against its database, as someone who can read the database and `SECRETS_KEY`. Both are recorded on the Activity page with the actor _System_.

| Command                                        | Does                                                                                                                                                                                                                              |
| :--------------------------------------------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run admin:reset -- --email <admin email>` | Sets a new password for an enabled admin, prints it once and ends their sessions ([SPEC-SIGN-IN](specs/SPEC-SIGN-IN.md) S19).                                                                                                     |
| `npm run two-factor:reset -- --email <email>`  | Turns off two-factor sign-in for any account, for someone who lost their phone and their recovery codes ([SPEC-TWO-FACTOR](specs/SPEC-TWO-FACTOR.md) 2.9). If it is required, they set it up again straight after their password. |

Try the gentler ways first: a recovery code at sign-in, or another admin's **Reset two-factor** on the Users page.

Both are `npm run` scripts, so they need a **source checkout** of the same version, with Node and `npm ci`; the image and the server install do not carry them yet ([SPEC-TWO-FACTOR](specs/SPEC-TWO-FACTOR.md) open question 3).

**On Coolify (Docker),** run them on the Coolify host, pointing at the volume:

1. Check out the tag the server runs: `git clone --branch vX.Y.Z https://github.com/jackbrumley/bmuster.git && cd bmuster && npm ci`.
2. Run the command as uid 1000, the image's user, so any `-wal` or `-shm` file it makes keeps the owner the server needs. Pass the three settings the scripts read:

   ```bash
   sudo -u '#1000' env \
     DATABASE_PATH=/var/lib/docker/volumes/<name>/_data/bmuster.db \
     SECRETS_KEY='<from your password manager>' \
     RELEASES_PATH=/tmp \
     npm run two-factor:reset -- --email you@example.com
   ```

   The server can keep running: SQLite lets both write, and the change applies to the next sign-in.

**On a server install** (Linux, `bmuster-server`), the database is `/var/lib/bmuster-server/bmuster.db` and `SECRETS_KEY` is in `/var/lib/bmuster-server/server.env`. Run the same command from a checkout as the `bmuster-server` user (`sudo -u bmuster-server env DATABASE_PATH=… SECRETS_KEY=… RELEASES_PATH=/tmp npm run …`), with the checkout readable by that user.

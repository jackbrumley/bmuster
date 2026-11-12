# SPEC-SHARE-LINKS: Short-lived links to one machine for someone without an account

**Status:** `IMPLEMENTED` except guest Files (section 8); version bump and changelog left for the release step · owner: "build everything", 2026-11-12 · design from `docs/access-and-sign-in.md` section 3 · **Date:** 2026-11-12

> **Security work** (AGENTS.md, "This tool controls other people's computers"). A share link lets someone with no account reach a machine's screen. It touches access, sessions, the session ticket and a new public page. Nothing here weakens an existing check: the link is a narrower grant than its creator's own, the agent enforces the ticket as for any session, and the person at the screen is always asked first.

## 1. Problem

An outside vendor needs to see (and sometimes drive) one computer, now, for an hour. Today the only way is an account, a group and a rule, which is slow and is left behind afterwards. MeshCentral's share links solve this; BMuster needs the same thing, treated like a key: short-lived, narrow, visible, revocable and audited.

## 2. What the design document decides (followed as written)

- Created from a machine's page by someone with `share-links` on that machine. Required: who it is for (free text), what it allows, how long.
- **What it allows:** _Watch desktop_ is always on; _Control desktop_ and _Files_ are tick boxes. Terminal is never offered. The creator can only tick what they hold on that machine.
- **How long:** 15 minutes, 1 hour, 4 hours, 8 hours, 24 hours. 24 hours is the maximum.
- Shown **once**, with a copy button. A 256-bit random token; the server stores only its hash.
- `https://<server>/s/<token>` opens a guest page: no console, the machine's desktop, a banner "Shared by <name> · ends <time>" and a countdown.
- **The person at the screen is always asked first** when someone is signed in, whatever the machine's rules say (SPEC-DESKTOP 7: share links always `ask`).
- One guest session at a time per link. When the time runs out the link stops and any open session ends.
- The machine's page lists its active links (who for, what, created by, time left), each with **End now**, which also closes an open session. Admins see every active link in one list.
- Audit: created, opened (time, IP address, browser), session started and ended, each file transfer, ended early, expired.
- Wrong or expired tokens get the same plain "This link has ended" page; repeated failures from one address are rate-limited.
- Table `share_links`: id, machine_id, token_hash, recipient, permissions (json), created_by, created_at, expires_at, ended_at, ended_by.

## 3. Decisions where the document is silent (the safer option)

| #   | Decision                                                                                                                                                                                                                                                                                                                                                                                                       |
| :-- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | **Consent.** A guest desktop ticket always carries consent `ask`. The server refuses `ask` sessions until the consent prompt exists (SPEC-DESKTOP phase 5), exactly as it does for `ask` rules, and the agent refuses an `ask` ticket too. So guest desktop sessions are refused with a plain reason until consent prompts ship. The check is never weakened to make links work. See open question 1.          |
| D2  | **Re-checked at every use.** A link works only while its creator is an enabled user who still holds `share-links` and every permission of the link on that machine, and the machine is still enrolled. When that stops being true the link **ends for good** (a later restore of the creator's access does not bring it back) and is audited.                                                                  |
| D3  | **Token:** `randomBytes(32)` as base64url (43 characters). Stored as lower-case hex SHA-256 under a unique index. The format is checked before any lookup; the stored hash is compared again with `timingSafeEqual`. A guess reveals nothing: the index is keyed by a hash the guesser cannot choose.                                                                                                          |
| D4  | **Guest cookie.** Loading `/s/<token>` sets `bmuster_guest`: HMAC-SHA256 (key derived from `SECRETS_KEY`) over the link id and an expiry, `Path=/s/<token>`, HttpOnly, Secure, SameSite=Strict, Max-Age no longer than the link's time left. Every guest API request needs the token **and** a cookie for the same link. A console session cookie is never read or needed on guest routes.                     |
| D5  | **Rate limit:** failures (a wrong, ended or malformed token; a missing or wrong guest cookie) are kept per address in `share_link_failures`. 10 within 15 minutes pause that address until the oldest of them is 15 minutes old. A paused request is refused (429) before the token is looked at. No server-wide pause: it would let one attacker lock real guests out, and a 256-bit token cannot be guessed. |
| D6  | **One session per link.** A reload re-attaches to the running session with a fresh browser ticket for that link only. Opening a session again (another tab, or switching between watch and control) ends the running one first, so there is never a second.                                                                                                                                                    |
| D7  | **Expiry:** a link stops at `expires_at` at once (checked on every request). A sweep every 10 seconds, and a timer at the exact end of a link with a running session, marks expired links ended (`share-link-expired`) and ends their sessions with "The share link ended".                                                                                                                                    |
| D8  | **End now** may be used by anyone with `share-links` on the machine (and admins): ending only takes access away. The machine's list is shown to the same people; admins see every active link on the Access page.                                                                                                                                                                                              |
| D9  | **Who the machine sees:** the ticket's user is `{ id: <link id>, name: "<recipient> (shared by <creator>)" }`, so the notice bar and the consent prompt name both. The recipient label is 1–80 characters with no control characters.                                                                                                                                                                          |
| D10 | **What the guest page reveals:** the machine's name and OS family, the creator's name, the recipient label, what the link allows and when it ends. Nothing about other machines, people, groups or the server.                                                                                                                                                                                                 |
| D11 | **Headers on guest pages:** `Referrer-Policy: no-referrer`, `Cache-Control: no-store`, `X-Robots-Tag: noindex`. Unexpected-error log lines redact the token from `/s/…` paths.                                                                                                                                                                                                                                 |
| D12 | **At most 20 active links per machine**, so a compromised account cannot mint links in bulk unnoticed.                                                                                                                                                                                                                                                                                                         |
| D13 | **Audit actor** for guest events is System (a guest has no account); the detail names the guest, who shared it, the link id, address and browser. Every entry carries the machine id, so members who can see the machine see them on Activity.                                                                                                                                                                 |
| D14 | **Files for guests** (upload and download only, never delete or rename) work only while the same link's desktop session is live, so they inherit the consent the person at the screen gave. See section 8.                                                                                                                                                                                                     |

## 4. Acceptance criteria

| #    | Criterion                                                                                                                                                                                                                                            | Test                                                                 |
| :--- | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :------------------------------------------------------------------- |
| SL1  | A token is 32 random bytes in base64url; only its SHA-256 is stored; the reply to Create is the only place the token appears.                                                                                                                        | `share-links.test.ts` "SL1"                                          |
| SL2  | Create needs `share-links` on the machine: a member without it is refused (403), a machine the person cannot see is 404, and nothing is stored.                                                                                                      | `share-links.test.ts` "SL2", `share-link-routes.test.ts` "SL2"       |
| SL3  | The link's permissions are a subset of the creator's own on that machine: ticking Control or Files without holding it is refused. Watch is always included; terminal can never be asked for.                                                         | `share-links.test.ts` "SL3"                                          |
| SL4  | Durations are only 15 min, 1 h, 4 h, 8 h or 24 h; anything else is refused by the schema.                                                                                                                                                            | `share-links.test.ts` "SL4"                                          |
| SL5  | Resolving a token: a valid one gives the guest grant; a wrong, malformed, expired or ended one gives the same "ended" answer.                                                                                                                        | `share-links.test.ts` "SL5", `share-link-routes.test.ts` "SL5"       |
| SL6  | A link stops working when its creator is disabled or loses `share-links` (or any permission it carries) on the machine, and it is then ended and audited.                                                                                            | `share-links.test.ts` "SL6"                                          |
| SL7  | End now marks the link ended (who, when), ends its running session at once, and is audited. Someone without `share-links` on that machine is refused; a link on another machine id is 404.                                                           | `share-links.test.ts` "SL7", `share-link-routes.test.ts` "SL7"       |
| SL8  | Expiry: the sweep marks expired links ended, audits `share-link-expired` once, and ends their sessions.                                                                                                                                              | `share-links.test.ts` "SL8"                                          |
| SL9  | Rate limit: after 10 failures from one address within 15 minutes, even a valid token from that address gets 429 without being looked up; another address is unaffected.                                                                              | `share-link-limits.test.ts` "SL9", `share-link-routes.test.ts` "SL9" |
| SL10 | Guest cookie: guest API requests without the cookie, with a cookie for another link, or with a tampered or expired cookie are refused and counted as failures.                                                                                       | `guest-cookie.test.ts` "SL10", `share-link-routes.test.ts` "SL10"    |
| SL11 | A guest desktop ticket names only the link's permissions (`desktop-view`, plus `desktop-control` only on a control link asking for control), consent `ask`, and the guest as "<recipient> (shared by <creator>)".                                    | `share-links.test.ts` "SL11"                                         |
| SL12 | Until consent prompts exist, a guest desktop session is refused (409) with a plain reason and nothing is sent to the agent.                                                                                                                          | `share-links.test.ts` "SL12"                                         |
| SL13 | One session per link: opening again ends the running session first; a reload gets a ticket for the link's own session and never for anyone else's.                                                                                                   | `guest-sessions.test.ts` "SL13"                                      |
| SL14 | Audit: `share-link-created`, `share-link-opened` (address, browser; once per cookie), `share-link-ended`, `share-link-expired`; guest sessions' `session-opened` / `session-ended` name the guest and the link.                                      | `share-links.test.ts` "SL14"                                         |
| SL15 | Lists: a machine's active links (who for, what, created by, ends) for people with `share-links` there; every active link for admins only.                                                                                                            | `share-links.test.ts` "SL15", `share-link-routes.test.ts` "SL15"     |
| SL16 | At most 20 active links per machine.                                                                                                                                                                                                                 | `share-links.test.ts` "SL16"                                         |
| SL17 | Share modal: recipient, duration, a Control tick box only when the person holds control (Files waits for the guest Files panel, section 8); Create shows the link once with Copy; the list shows time left and End now asks first (`confirmAction`). | `share-links-panel.svelte.test.ts` "SL17"                            |
| SL18 | Guest page: banner "Shared by <name> · ends <time>", a countdown, the desktop; an ended link shows "This link has ended" and nothing else.                                                                                                           | `guest-page.svelte.test.ts` "SL18"                                   |
| SL19 | The guest page sends `Referrer-Policy: no-referrer` and `Cache-Control: no-store`; error log lines redact `/s/<token>`.                                                                                                                              | `share-link-routes.test.ts` "SL19", `handle-error.test.ts` "SL19"    |

## 5. Schema (additive, generated)

`src/lib/server/database/schema/share-links.ts`:

- `share_links`: `id` text PK; `machine_id` → machines; `token_hash` text unique; `recipient` text; `permissions` text (JSON list of `desktop-view`, `desktop-control`, `files`); `created_by` → users; `created_at`, `expires_at` (ms); `ended_at` (ms, null while active); `ended_by` → users (null when it expired or ended by itself). Index on (`machine_id`, `ended_at`).
- `share_link_failures`: `id`, `address`, `failed_at`; index on (`address`, `failed_at`). Rows older than a day are deleted when a new one is written.

## 6. Routes

| Route                                 | Guard         | Does                                                                           |
| :------------------------------------ | :------------ | :----------------------------------------------------------------------------- |
| `GET /api/machines/[id]/share-links`  | `route.user`  | Active links on the machine (needs `share-links` there) and what may be ticked |
| `POST /api/machines/[id]/share-links` | `route.user`  | Create; replies with the link and its URL, once                                |
| `DELETE /api/share-links/[id=uuid]`   | `route.user`  | End now (needs `share-links` on the link's machine)                            |
| `GET /api/share-links`                | `route.admin` | Every active link                                                              |
| `GET /s/[token]`                      | `page.public` | Rate limit, resolve, set the guest cookie, audit "opened", the guest page      |
| `GET /s/[token]/status`               | `route.guest` | Still active and when it ends (the page polls it)                              |
| `POST /s/[token]/session`             | `route.guest` | Open (or re-attach to) the link's desktop session                              |
| `POST /s/[token]/browser-ticket`      | `route.guest` | A fresh browser ticket for the link's own running session                      |

`route.guest` is a new guard: rate limit → token → guest cookie for the same link → link still valid (D2). The browser's socket is the existing `/api/sessions/[id]/socket?ticket=…`.

## 7. Security notes

- The guest never gets a console session, and guest routes never read the console cookie. A guest grant names one link, so one machine; every guest request re-resolves the link (expiry, end, creator's access).
- The ticket the agent receives names only the link's permissions, so the agent refuses input on a watch-only link exactly as for a member.
- The origin check (SPEC-SIGN-IN S8) covers every guest POST; the guest cookie is SameSite=Strict on top.
- Revocation is immediate: the row is ended and the relay ends the session in the same request.
- Nothing about other machines or people leaks: every refusal is the same plain page or `{ message }`.

## 8. Not in this change

- **Consent prompts** (SPEC-DESKTOP phase 5). Until they exist, guests cannot connect (D1).
- **Guest Files panel.** The link records Files and the ticket carries it, but the guest page has no Files panel yet; the tick box is shown only once the panel exists. Its routes will be upload and download only, under `route.guest`, allowed while the link's desktop session is live (D14).
- Email notifications for share-link events (SPEC-EMAIL lists them as first events).

## 9. Open questions

1. **Consent prompts first?** Share links cannot connect until the consent prompt ships. Build phase 5 next, or allow guests unattended when the machine reports nobody signed in? (The second is racy: someone can sign in between the report and the session. Recommended: build phase 5.)
2. Should ending a creator's access end their links silently (D2, as built) or warn them first?
3. Should admins be able to forbid share links server-wide (a setting, default on)?

## 10. As built

- **The consent gate is one function**, `canAskAtScreen()` in `services/sessions/sessions.ts`, used by both `ask` rules and share links. `guest-sessions.test.ts` lifts it with a mock to prove the guest session end to end (ticket, one session per link, End now and expiry closing it, audit), so the day consent prompts land nothing else changes.
- **Session records** carry `viewer: { kind: 'user' } | { kind: 'guest'; shareLinkId; sharedByUserId }`. A guest session's relay owner id is the link id, which gives one-session-per-link and browser tickets scoped to the link. Session audit entries for guests use the System actor and name the guest and the link. New end reason `share-link-ended`.
- **`SessionLink`** takes a `SessionRoute` (open URL, ticket request, storage key); `consoleSessionRoute()` gives the console's. The guest page reuses `DesktopSession`, `DesktopCanvas`, `attachScreenInput`, `FullScreen` and `KeyBar` unchanged apart from that one constructor argument.
- **Admins' list** is a panel on the Access page; the machine's list is a panel on the machine's Overview, shown to people with `share-links` there.
- **Files:** the API accepts `files: true` (only from someone who holds `files`) and stores it, but the modal does not offer it and the guest page has no Files panel yet.

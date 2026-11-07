# SPEC-SIGN-IN: Accounts, sign-in and identity providers

**Status:** `IN PROGRESS` (S1–S16 built; S17–S19 to do) · approved 2026-11-07 · **Date:** 2026-11-07 · **Version target:** 0.3.0

## 1. Problem

The console has no accounts. Anyone who can reach it can make join codes and, soon, open terminals on every machine. Until this spec lands the server only starts with `CONSOLE_AUTH=none-development`. This spec adds people, passwords, Microsoft 365 / Authentik sign-in, console sessions and route guards, and removes that flag.

**In scope:** first-run setup, server settings, users (admin and member), password sign-in, OpenID Connect providers, console sessions, sign-out, guards on every console route and API, a minimal audit log for sign-ins and admin changes.

**Out of scope (later specs):** user and machine groups and access rules (SPEC-ACCESS); share links; provider group sync; MCP tokens. Until SPEC-ACCESS lands, **members see no machines**; only admins do.

Design background: `docs/access-and-sign-in.md` sections 1, 2 and 4.

## 2. Acceptance criteria

| #   | Criterion                                                                                                                                                                                                                                                                       | Test                                             |
| :-- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | :----------------------------------------------- |
| S1  | With no users, every page redirects to `/setup`, which creates the first admin (name, email, password) once; afterwards `/setup` is gone.                                                                                                                                       | `setup.test.ts`                                  |
| S2  | A password is at least 12 characters and is stored only as an Argon2id hash.                                                                                                                                                                                                    | `passwords.test.ts`                              |
| S3  | Signing in with the right email and password starts a console session; the wrong password gives one plain message that does not say which part was wrong.                                                                                                                       | `password-sign-in.test.ts`                       |
| S4  | After 5 failed attempts for one email, sign-in for that email pauses for 5 minutes (from any address).                                                                                                                                                                          | `password-sign-in.test.ts`                       |
| S5  | A session is an opaque random id in an HttpOnly, Secure, SameSite=Lax cookie; the database stores only its SHA-256. Sessions end after 12 hours idle or 30 days at most.                                                                                                        | `sessions.test.ts`                               |
| S6  | Sign-out ends the session. Disabling a user ends all their sessions at once.                                                                                                                                                                                                    | `sessions.test.ts`                               |
| S7  | Every console page and `/api/*` route needs a session; admin routes need the admin role. Agent routes (`/agent/*`, `/install.*`) keep their own checks. A route with no guard fails hygiene.                                                                                    | `guards.test.ts`, hygiene `route-guard-required` |
| S8  | State-changing requests from another origin are refused.                                                                                                                                                                                                                        | `origin-check.test.ts`                           |
| S9  | An admin adds an OIDC provider (Microsoft 365 preset, Authentik preset, or generic): issuer URL, client id, client secret (encrypted, write-only), and new-people mode (invited only, or auto-create with no access).                                                           | `identity-providers.test.ts`                     |
| S10 | "Continue with <provider>" runs the authorisation code flow with PKCE, `state` and `nonce`; the ID token is checked against the provider's keys; a user is matched by (provider, subject), then by an invited email.                                                            | `oidc-sign-in.test.ts` (against a fake provider) |
| S11 | Admins can always sign in with a password, even when providers are on. A member linked to a provider has no password unless an admin sets one.                                                                                                                                  | `password-sign-in.test.ts`                       |
| S12 | Admins can add (invite) users and edit them: name, email (password accounts only; a provider keeps its own), role, disabled or enabled, and a new password for a member. An admin cannot disable or demote the last active admin.                                               | `users.test.ts`                                  |
| S13 | Sign-ins (success and failure), sign-outs, user and provider changes go to the audit log, shown on the Activity page.                                                                                                                                                           | `audit.test.ts`                                  |
| S14 | The console shows the signed-in person at the bottom of the sidebar and on More; sign-out works there.                                                                                                                                                                          | `shell-frame.svelte.test.ts`                     |
| S15 | `CONSOLE_AUTH` is removed; the server starts without it.                                                                                                                                                                                                                        | `env.test.ts`                                    |
| S16 | Admins change server settings on a Settings page. Each setting is declared once in `settings-definitions.ts` (key, type, default, who may change it); changes are audited. First settings: _Default for new access rules_ (`unattended`), _Show a notice while connected_ (on). | `settings.test.ts`                               |
| S17 | On first start with no users the server prints a one-time setup code to its log; `/setup` needs that code before it creates the first admin.                                                                                                                                    | `setup.test.ts`                                  |
| S18 | If `BMUSTER_ADMIN_EMAIL` and `BMUSTER_ADMIN_PASSWORD` are set and there are no users, the server creates that admin at start-up and skips `/setup`. They never change an existing account; the server logs a reminder to remove them.                                           | `setup.test.ts`                                  |
| S19 | `npm run admin:reset -- --email <email>`, run on the server, sets a new password for an admin (printed once) and ends their sessions; it is audited.                                                                                                                            | `admin-reset.test.ts`                            |

## 3. Flows

**First run.** No users → every request redirects to `/setup` → the person makes the first admin → signed in → Machines.

**Password.** `/login` → email and password → session cookie → the page they asked for (a same-origin path only).

**Provider.** `/login` → Continue with Microsoft 365 → `/auth/oidc/<id>/start` (PKCE verifier, `state`, `nonce` in a 10-minute HttpOnly cookie) → provider → `/auth/oidc/<id>/callback` → check state, swap the code, check the ID token → find or create the user → session → Machines. A new person in "auto-create" mode lands on an "Awaiting access" page.

## 4. Schema (additive)

| Table                | Columns                                                                                                                                                                          |
| :------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `users`              | id, name, email (unique, lower case), role (`admin`/`member`), password_hash (nullable), disabled_at (nullable), created_at, last_sign_in_at (nullable)                          |
| `identity_providers` | id, name, kind (`microsoft-entra`/`authentik`/`generic-oidc`), issuer, client_id, client_secret_sealed, scopes (json), new_people (`invited`/`auto-create`), enabled, created_at |
| `user_identities`    | id, user_id, provider_id, subject; unique (provider_id, subject)                                                                                                                 |
| `console_sessions`   | id_hash (pk), user_id, created_at, last_seen_at, expires_at, user_agent, ip                                                                                                      |
| `sign_in_failures`   | email, failed_at (for the pause in S4; old rows pruned)                                                                                                                          |
| `audit_entries`      | id, at, actor_user_id (nullable), kind, target, detail (json)                                                                                                                    |
| `settings`           | key (pk), value (json), updated_at, updated_by                                                                                                                                   |

`join_codes.created_by` is added (nullable for codes made before this spec).

## 5. Routes

| Method                   | Path                                                           | Guard                                 |
| :----------------------- | :------------------------------------------------------------- | :------------------------------------ |
| GET, POST                | `/setup`                                                       | public, only while there are no users |
| GET, POST                | `/login`                                                       | public                                |
| POST                     | `/logout`                                                      | user                                  |
| GET                      | `/auth/oidc/[id=uuid]/start`, `/auth/oidc/[id=uuid]/callback`  | public                                |
| all                      | console pages, `/api/*`                                        | user; admin pages and APIs: admin     |
| GET, POST, PATCH         | `/api/users`, `/api/users/[id=uuid]`                           | admin                                 |
| GET, POST, PATCH, DELETE | `/api/identity-providers`, `/api/identity-providers/[id=uuid]` | admin                                 |
| GET, PATCH               | `/api/settings`                                                | admin                                 |

Guards follow the portal's pattern: `route.public`, `route.user`, `route.admin`, `route.agent`; the handler receives only what the guard proved (`{ user }`).

## 6. Libraries

- `@node-rs/argon2` 2.2.2 (as in the portal).
- `openid-client` 6.8.9 (discovery, PKCE, ID token checks).

## 7. Security notes

- Session ids are 32 random bytes; only their hash is stored.
- Cookie `Secure` is always on; the dev server is HTTPS for this reason.
- Redirect targets after sign-in must be same-origin paths.
- Rate limiting is per email (S4) and per address (20 failures in 10 minutes pauses that address).
- Provider client secrets use the same AES-256-GCM sealing as the server key.

## 8. Decisions (2026-11-07)

1. **Two-factor (TOTP):** later, but before the first public release.
2. **Members before SPEC-ACCESS:** they can sign in and see an empty console, so invites can be tested.
3. **Session lengths:** 12 hours idle, 30 days at most.
4. **Notice while connected:** on by default, with a server setting to turn it off (audited).

## 9. As built (S1–S16)

Built as specified unless listed here. S17–S19 (setup code, admin environment variables, `admin:reset`) are not built yet.

**Different from the spec**

- `sign_in_failures` also has `id` and `address` columns: the per-address limit (section 7) needs the address, and the table needs a key.
- The email pause (S4) counts failures over the last 15 minutes; 5 of them pause that email until 5 minutes after the latest. The address pause counts 20 failures in 10 minutes. A paused attempt is refused before the password is checked and is audited as `sign-in-failed` (`paused-email` / `paused-address`).
- `/setup` after the first admin exists redirects to `/login` instead of answering 404.
- The "Awaiting access" page is the Machines page: a member sees "Your access hasn't been set up yet" there (decision 8.2). A person auto-created by a provider lands on it.
- Activity is admin-only (it shows other people's sign-ins). Members see only Machines and More.
- Machine pages (`/machines/[id]/…`) and machine removal are admin-only until SPEC-ACCESS.
- Sign-in providers moved to `/(console)/sign-in`; `/(console)/settings` now holds the S16 settings.
- Only a member's password can be reset by another admin; an admin can set their own. Resetting a password ends that member's sessions.
- An invited user is linked by email only when the provider does not mark the email unverified, and only if that user has no other identity at the same provider. With no verified email the person is refused (or, for auto-create, also refused: an account needs an email).
- openid-client does not check the ID token's signature when it comes straight from the token endpoint (OIDC Core 3.1.3.7 allows this over TLS). The flow switches `enableNonRepudiationChecks` on, so the signature is always checked against the provider's JWKS. The OIDC test proves an ID token signed by another key is refused.
- The OIDC flow cookie (`bmuster_oidc`, path `/auth/oidc/`, 10 minutes) holds the PKCE verifier, state, nonce and return path sealed with `SECRETS_KEY` (AES-256-GCM), so it can be neither read nor forged.
- Discovery runs on every start and callback (no cache); fine at sign-in volumes.
- The origin check (S8) also refuses a state-changing request with no `Origin` header. Agent paths (`/agent/*`, `/install.sh`, `/install.ps1`) skip the session and origin hooks; `/agent/v1/check-in` uses `route.agent` (the signed-request check), enrolment and downloads use `route.public`.
- Universal `+page.ts` loads are gone; the `route-guard-required` hygiene rule also refuses a universal `load`.

**Tests**

- S10 runs against a local fake provider (tests/helpers/fake-oidc-provider.ts): discovery, the authorisation URL, the token request (client secret, code, PKCE verifier) and the RS256 ID token are all real. The provider says it is `https://127.0.0.1:<port>`; the test's `discover` gives openid-client a transport that sends those requests over plain http.
- The unit test project sets `DATABASE_PATH=:memory:` (vite.config.ts), so a test that loads the server's database never opens the developer's file.

**Not done**

- Version bump and changelog (no `src/lib/changelog.ts` exists yet); left for the release step.
- No self-service "change my password" page; an admin sets their own password from the Users page.

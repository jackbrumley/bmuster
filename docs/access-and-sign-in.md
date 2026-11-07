# Access and sign-in

Status: agreed 2026-11-07. Shown in the UI prototype (Users, Groups, Access rules, Sign-in, the sign-in page). Based on the SSO design in Midfield Digital Labs, made single-tenant.

Two separate questions:

- **Sign-in (authentication):** who are you? A password, or an identity provider such as Microsoft 365 or Authentik.
- **Access (authorisation):** what may you do, on which machines? Set only in BMuster, by groups and rules.

## 1. Access model

```
people ──member of──▶ user groups ──┐
                                    ├── access rule: permissions + consent
machines ─member of─▶ machine groups┘
```

- A person can be in many **user groups**. A machine can be in many **machine groups**.
- An **access rule** joins one user group to one machine group, with a set of permissions and a consent setting.
- A person's permissions on a machine are the **union** of every rule that matches both. There are no deny rules: rules only add.
- Example: Helpdesk → Staff computers gives _watch and control desktop, files_. Engineers → Staff computers adds _terminal_. Someone in both groups gets all of it.

### Permissions

| Permission        | Allows                                    |
| ----------------- | ----------------------------------------- |
| `view`            | See the machine and its inventory         |
| `terminal`        | Open a terminal                           |
| `desktop-view`    | Watch the desktop                         |
| `desktop-control` | Control the desktop (includes watching)   |
| `files`           | Browse, send and fetch files              |
| `share-links`     | Create short-lived links for someone else |

Every other permission includes `view`. New permissions are added to one list in `lib/domain/access/access.ts`; the compiler then lists every place that must handle them.

### Consent

Each rule says **ask** (the person at the screen accepts or declines) or **unattended** (connect at once). When several rules give the same permission, the session is unattended if any of those rules says unattended. This matches "rules only add".

### Console roles

- **Admin:** manages users, groups, rules, sign-in settings and enrolment, and has every permission on every machine.
- **Member:** sees only machines where a rule gives at least `view`.

### Enforcement

- The server works out permissions when it lists machines and again when a session starts.
- A session ticket sent to the agent names the permissions it carries (signed by the server), so the agent refuses, for example, keyboard input on a watch-only session.
- Every sign-in, session and change to users, groups or rules goes to the audit log.

## 2. Sign-in

### Password

- Hashes with Argon2id (`@node-rs/argon2`, as in the portal).
- The first admin is made at setup with a password.
- **Break-glass:** admins can always sign in with a password, so a broken provider never locks the owner out. Members get a password only if an admin gives them one.

### Identity providers (OpenID Connect)

- One generic OIDC type covers Microsoft Entra ID (Microsoft 365), Authentik, Keycloak, Google and others. Preset forms for Microsoft 365 and Authentik fill in the issuer URL.
- Authorisation code flow with PKCE, `state` and `nonce` in a short-lived HttpOnly cookie; ID tokens checked against the provider's JWKS. Library: `openid-client` (proposed).
- Client secrets are encrypted at rest (AES-256-GCM, key from an environment variable) and are write-only in the UI.
- A user is linked to a provider by `(provider, subject)`; the email is shown, never used as the key.

### New people

Per provider, one of:

- **Invited only:** an admin adds the person (or invites by email); the first sign-in links the account.
- **Auto-create:** anyone the provider accepts gets an account in no groups, and sees an "Awaiting access" page until an admin adds them to a group.

Later: map provider groups (Entra `groups` claim, Authentik groups) to BMuster user groups, so membership follows the directory.

### Console sessions

- An opaque session id in an HttpOnly, Secure, SameSite=Lax cookie; the session row lives in SQLite.
- Sign-out deletes the row. Disabling a user deletes all their sessions.

## 3. Share links

A share link gives someone without an account (an outside vendor, urgently) access to **one machine** for a **limited time**. Anyone holding the link can open it, so it is treated like a key: short-lived, narrow, visible and revocable. Based on the MeshCentral feature people like.

### Creating one

- From a machine's page, by someone with the `share-links` permission on that machine.
- **Required:** who it is for (free text, e.g. "Dave, Acme Printers"), what it allows, and how long it lasts.
- **What it allows:** tick boxes. _Watch desktop_ is always on; tick _Control desktop_ and _Files_ (upload and download, e.g. to send an installer) as needed. Terminal is never offered; anyone who needs a shell gets an account. The creator can only tick what they hold themselves on that machine.
- **How long:** chosen from a list: 15 minutes, 1 hour, 4 hours, 8 hours, 24 hours. **24 hours is the maximum.** Longer access means an account with a group and a rule.
- The link is shown **once**, with a copy button. It contains a 256-bit random token; the server stores only its hash.

### Using one

- `https://<server>/s/<token>` opens a guest page: no console, just the machine's desktop (and a Files panel if ticked), a banner ("Shared by Jack Brumley · ends 3:40 pm") and a countdown.
- **The person at the screen is always asked first** when someone is signed in, whatever the machine's rules say. A machine at the sign-in screen, with nobody to ask, connects straight away.
- One guest session at a time per link.
- When the time runs out, the link stops working **and any open session ends**.

### Control and record

- The machine's page lists its active links: who for, what, created by, time left. Each has **End now**, which also closes an open session.
- Admins see every active link in one list.
- Audit entries: created, opened (time, IP address, browser), session started and ended, each file uploaded or downloaded (name, size, SHA-256), ended early, expired.
- Wrong or expired tokens get the same plain "This link has ended" page, and repeated failures from one address are rate-limited.

### Table

| Table         | Columns                                                                                                           |
| ------------- | ----------------------------------------------------------------------------------------------------------------- |
| `share_links` | id, machine_id, token_hash, recipient, permissions (json), created_by, created_at, expires_at, ended_at, ended_by |

## 4. Tables (sketch)

| Table                                     | Holds                                                                    |
| ----------------------------------------- | ------------------------------------------------------------------------ |
| `users`                                   | name, email, role, password hash (nullable), disabled                    |
| `identity_providers`                      | name, kind, issuer, client id, encrypted secret, scopes, new-people mode |
| `user_identities`                         | user, provider, subject (unique per provider)                            |
| `console_sessions`                        | user, created, last seen, expires                                        |
| `user_groups`, `user_group_members`       | groups of people                                                         |
| `machine_groups`, `machine_group_members` | groups of machines                                                       |
| `access_rules`                            | user group, machine group, permissions (JSON list), consent              |

## 5. Open questions

1. Should a rule be able to target "all machines", without a machine group?
2. Provider group sync in the first release, or later?

# SPEC-TWO-FACTOR: Two-factor sign-in (authenticator app and recovery codes)

**Status:** `IMPLEMENTED (pending release)` (As built: section 11) · **Date:** 2026-11-14 · Decisions: Jack, 2026-11-14 (section 3) · Builds on SPEC-SIGN-IN (passwords, sessions, sign-in limits, `admin:reset`), SPEC-COMMANDS C10 (recent sign-in) and SPEC-MCP (approvals), `docs/access-and-sign-in.md` section 2.

> **Security work.** This changes password sign-in, adds a half-signed-in state, changes the recent sign-in check used by Commands runs and AI approvals, adds an admin reset and a host command. Nothing here weakens a check: every new step is in addition to the password, wrong codes count toward the existing pauses, and admins can still always sign in with a password (with their code when two-factor is on for them).

## 1. Problem

Whoever signs in to BMuster as an admin controls every enrolled computer. Today a password is the only thing between a phished or reused password and those computers. SPEC-SIGN-IN decision 8.1 put two-factor sign-in "later, but before the first public release". This spec adds it: a code from an authenticator app, with single-use recovery codes for a lost phone.

**In scope:** authenticator app (TOTP, RFC 6238) and recovery codes; the server setting; set-up, turning off and new recovery codes on the Account page; the code step at sign-in; forced set-up when required; the recent sign-in check; the Users page view and admin reset; the host command; audit.

**Out of scope:** emailed codes (decision 1); "trust this device"; passkeys (a later step 2, section 10); two-factor for people who sign in through an identity provider (their provider handles it).

## 2. Behaviour

### 2.1 The setting

**Two-factor sign-in** (Settings → Security), one of:

| Value                 | Meaning                                                         |
| :-------------------- | :-------------------------------------------------------------- |
| Off                   | Nobody is made to use it. Anyone may turn it on for themselves. |
| Required for admins   | Admins who sign in with a password must use it. Members may.    |
| Required for everyone | Everyone who signs in with a password must use it.              |

- The declared default is **Off**, so a server that updates has no row and stays Off: nobody is locked out by upgrading.
- A **new** server gets **Required for admins**: `/setup` and the `BMUSTER_ADMIN_EMAIL` start-up path write it, as the system, in the same transaction that creates the first admin.
- Changes are audited as `setting-changed` like every setting.
- Turning it on does not end anyone's session. It applies from each person's next password sign-in. The Account page tells a required person who has not set it up yet.

### 2.2 Who is asked, and when

After a right password (at `/login`, at the end of `/setup`, and on accepting an invitation):

1. Two-factor is **on** for the person → the **code step**.
2. Else it is **required** for them by the setting → the **set-up step**.
3. Else → signed in, as today.

People who sign in through an identity provider (OIDC) are never asked, whatever the setting: the provider handles their second factor. Two-factor protects the password, so only people with a password can turn it on.

### 2.3 The half-signed-in state (challenge)

- A right password for someone with a second step starts a **sign-in challenge**, not a session: 32 random bytes in an HttpOnly, Secure, SameSite=Lax cookie `bmuster_sign_in` on path `/login`, lasting **5 minutes**. The database keeps only its SHA-256, the person, the step (`code` or `set-up`) and the expiry.
- The challenge grants nothing else. The session hook never reads it, so every console page and `/api/*` route still sees a signed-out browser. Only the two step pages read it.
- A challenge is used once: finishing the step deletes it and starts the console session. An expired or unknown challenge sends the person back to `/login` with "Your sign-in timed out. Sign in again."
- Starting a new challenge for a person deletes their older ones.

### 2.4 The code step

- `/login/two-factor`: "Enter the 6-digit code from your authenticator app." One field. A **Use a recovery code instead** switch changes the label and keyboard; the server accepts either form whatever the switch says.
- A code is accepted for the current 30-second step and one step either side (clocks that drift by up to 30 seconds).
- Each step is accepted only once per person: the last used step is kept, and a code for that step or an earlier one is refused. This stops a code seen over someone's shoulder being replayed within its 90 seconds.
- A recovery code works once. Sign-in with one is audited with how many remain.
- Wrong codes count toward the SPEC-SIGN-IN S4 pauses for the person's email and the browser's address. A paused email or address is refused before the code is checked.
- A right password no longer clears the email's failed attempts when a second step follows. Only finishing the sign-in does. Otherwise someone who has the password could re-type it to reset the count and guess codes without pause.

### 2.5 The set-up step (required but not set up)

- `/login/two-factor/set-up`: the same set-up as the Account page (2.6) without the password field, since the password was typed moments ago. The person can do nothing else until it is done: there is no session yet.
- The key is made once per set-up and kept, sealed, as **pending**. Reloading the page or signing in again within an hour shows the same key, so a QR code already scanned keeps working.
- After the first right code, two-factor is on, the session starts and the 10 recovery codes are shown once, with **Continue** to the page they asked for.

### 2.6 The Account page

A **Two-factor sign-in** panel.

- **No password** (provider-only): "You sign in through <provider>, which handles two-step checks." No buttons.
- **Off:** a sentence on what it is. If the setting requires it for this person, a warning notice says so ("Required for admins on this server. Set it up now; you will be asked at your next sign-in."). **Set up** opens the set-up modal.
- **Set-up modal:**
  1. A QR code of the `otpauth://totp/BMuster:<email>?secret=<key>&issuer=BMuster&algorithm=SHA1&digits=6&period=30` URI, drawn on the server as an SVG path (no request leaves the server; the browser draws a `<path>`). Under it, the key in groups of four for typing in by hand, with Copy.
  2. **Code from the app** and **Your password** fields, and **Turn on**.
  3. On success the modal shows the 10 recovery codes **once**, with **Copy** and **Download** (`bmuster-recovery-codes.txt`), and **Done**.
- **On:** "On since <date>. <n> of 10 recovery codes left." (a warning notice when 3 or fewer are left). Two buttons:
  - **New recovery codes:** asks for a current authenticator code, then shows the new set once (Copy, Download). The old set stops working.
  - **Turn off:** asks for the password and a current code or a recovery code. Refused, with the reason, while the setting requires it for them; the button is not offered then.
- The key is never sent again after set-up. The page shows only whether it is on.

### 2.7 The recent sign-in check

SPEC-COMMANDS C10 asks a person who signed in more than 10 minutes ago to prove it is still them before a Commands run or an AI approval.

- **Decision: with two-factor on, the check asks for a current authenticator code instead of the password.** The threat is someone at a browser the person walked away from. A browser's password manager fills the password for that someone; it does not have the person's phone. Asking for both adds typing without adding a factor the walk-up person might have. (Recommended; see open question 1.)
- Recovery codes are not accepted here: they are for a lost phone, and spending one on a routine check would waste it. The message says "Lost your phone? Sign out, then sign in with a recovery code."
- Without two-factor nothing changes: the password, or "sign in again" for provider-only people.
- A wrong code counts toward the pauses, exactly like a wrong password there today. A right one sets the session's `reconfirmed_at`.
- The request field that carried the password becomes `recheck`: `{ kind: 'none' } | { kind: 'password'; password } | { kind: 'code'; code }`, for both `POST /api/commands/runs` and `POST /api/commands/runs/<id>/approve`. Every caller changes in the same commit.

### 2.8 Users page (admins)

- Each row shows a **Two-factor** badge when it is on; the view modal has a **Two-factor** line (On since <date> / Off).
- **Reset two-factor** on another person's view modal (not their own: they turn it off on Account), after `confirmAction`. It deletes the person's key and recovery codes, is audited, and leaves their sessions alone. If the setting requires it for them, they set it up again at their next password sign-in.
- Admins may reset another admin's two-factor (unlike passwords). An admin who loses their phone and recovery codes then needs only a colleague, not a shell on the server. Resetting does not give the resetting admin the other admin's password, so it does not let them in.

### 2.9 Host reset (the last admin's way back)

- Host commands today are `npm run` scripts run from a source checkout on the server, against the server's `.env` (`npm run admin:reset -- --email <email>`, SPEC-SIGN-IN S19). This follows the same pattern: **`npm run two-factor:reset -- --email <email>`** (`scripts/two-factor-reset.ts` over `services/auth/two-factor-reset.ts`).
- For any existing account (admin or member, enabled or not): deletes the key, the recovery codes and any pending set-up, clears the email's failed-attempt pause, and ends the person's sign-in challenges. Audited as `two-factor-reset` with actor _system_ and `how: from the server command line`. Unknown emails exit with code 1 and a plain message.
- With the password lost too, run `admin:reset` as well (admins only).
- `docs/hosting.md` documents both, including the Docker case (section 9, open question 3).

### 2.10 Audit

| Event                   | Kind                      | Detail                                                                   |
| :---------------------- | :------------------------ | :----------------------------------------------------------------------- |
| Set up (turned on)      | `two-factor-turned-on`    | `where` (Account page, or at sign-in)                                    |
| Signed in with a code   | `sign-in`                 | `method: password and authenticator code` (or `… recovery code`), `ip`   |
| Recovery code used      | `recovery-code-used`      | `for` (signing in, turning two-factor off), `remaining`                  |
| Wrong code              | `sign-in-failed`          | `method: authenticator code`, `reason: wrong-code` (or `paused-…`), `ip` |
| Re-check with a code    | `code-confirmed`          | `ip`                                                                     |
| Turned off              | `two-factor-turned-off`   | `with` (authenticator code, recovery code)                               |
| Recovery codes replaced | `recovery-codes-replaced` | `ip`                                                                     |
| Admin reset             | `two-factor-reset`        | `how: by an admin` (actor is the admin, target the person)               |
| Host reset              | `two-factor-reset`        | `how: from the server command line` (actor system)                       |
| Setting changed         | `setting-changed`         | as today                                                                 |

## 3. Decisions (Jack, 2026-11-14)

1. Authenticator app (TOTP) and recovery codes only. No emailed codes.
2. The setting has three values (2.1). Required for admins is the default on a new server; existing servers stay Off. A required person who has not set it up is taken to set-up straight after their password and can do nothing else first. OIDC sign-ins are never asked.
3. The recent sign-in check asks for an authenticator code when two-factor is on. This spec decides: instead of the password (2.7).
4. Passkeys are a later step 2. Leave room, build nothing.

## 4. Acceptance criteria

| #    | Criterion                                                                                                                                                                                                                                                     | Test                                                                                         |
| :--- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | :------------------------------------------------------------------------------------------- |
| TF1  | The **Two-factor sign-in** setting has Off, Required for admins, Required for everyone. With no stored value it is Off. `/setup` and the start-up admin set it to Required for admins.                                                                        | `two-factor-policy.test.ts`, `setup.test.ts`                                                 |
| TF2  | Starting set-up gives an `otpauth://` URI with issuer BMuster and the person's email, the base32 key (160 bits), and a QR code drawn on the server as an SVG path. The key is stored only sealed with `SECRETS_KEY`; nothing after set-up returns it.         | `two-factor.test.ts`, `two-factor-qr.test.ts`, `base32.test.ts`                              |
| TF3  | Turning it on needs a right first code (and the password on the Account page). It then returns 10 recovery codes once; the database keeps only their SHA-256.                                                                                                 | `two-factor.test.ts`                                                                         |
| TF4  | A code is accepted for the current step and one step either side, not two. A code for a step already used (or an earlier one) is refused for that person.                                                                                                     | `two-factor.test.ts`                                                                         |
| TF5  | With two-factor on, a right password starts no session: it starts a 5-minute challenge. The right code (or a recovery code) then starts the session and ends the challenge. An expired, used or unknown challenge is refused.                                 | `two-factor-sign-in.test.ts`                                                                 |
| TF6  | Wrong codes count toward the email and address pauses; a paused email is refused before the code is checked; a right password does not clear the failures when a code step follows.                                                                           | `two-factor-sign-in.test.ts`                                                                 |
| TF7  | A challenge grants nothing: its token is not a session, and the session hook ignores its cookie.                                                                                                                                                              | `two-factor-sign-in.test.ts`                                                                 |
| TF8  | Someone required to use it who has not set it up gets the set-up step after a right password (sign-in, first-run setup, invitation), and a session only after confirming a first code. Someone not required gets a session as today. OIDC sign-in never asks. | `two-factor-sign-in.test.ts`, `setup.test.ts`, `invitations.test.ts`, `oidc-sign-in.test.ts` |
| TF9  | The set-up step reuses a pending key made within the last hour, so a scanned QR code keeps working across a reload or a new sign-in.                                                                                                                          | `two-factor.test.ts`                                                                         |
| TF10 | A recovery code works once, for sign-in or turning off; using one is audited with how many remain.                                                                                                                                                            | `two-factor-sign-in.test.ts`                                                                 |
| TF11 | Turning off needs the password and a current code or a recovery code, and is refused while the setting requires two-factor for the person.                                                                                                                    | `two-factor.test.ts`                                                                         |
| TF12 | New recovery codes need a current authenticator code and replace the whole old set.                                                                                                                                                                           | `two-factor.test.ts`                                                                         |
| TF13 | With two-factor on, the recent sign-in check asks for a code (`{ kind: 'code' }`), accepts a right one, refuses a recovery code and counts a wrong one toward the pauses. Commands runs and approvals send `recheck`.                                         | `recent-sign-in.test.ts`, `commands-service.test.ts`, `assistant-approval.test.ts`           |
| TF14 | The Users page shows who has two-factor on. An admin resets another person's two-factor after a confirmation (not their own); it is audited; that person sets it up again at their next sign-in if it is required.                                            | `two-factor-reset.test.ts`, `users-two-factor.svelte.test.ts`                                |
| TF15 | `npm run two-factor:reset -- --email <email>` resets any account's two-factor, clears its pause, and is audited with actor system; an unknown email changes nothing.                                                                                          | `two-factor-reset.test.ts`                                                                   |
| TF16 | Every event in 2.10 is written to the audit log with a label on Activity.                                                                                                                                                                                     | `two-factor.test.ts`, `two-factor-sign-in.test.ts`, `activity.test.ts`                       |
| TF17 | The Account page sets it up (QR, key, code, password, recovery codes with Copy and Download as .txt), shows on/off and recovery codes left, and offers Turn off and New recovery codes.                                                                       | `account-two-factor.svelte.test.ts`, `recovery-codes.svelte.test.ts`                         |
| TF18 | The code step page takes a code or, after **Use a recovery code instead**, a recovery code, with a 16px field, `autocomplete="one-time-code"` and visible errors.                                                                                             | `two-factor-step.svelte.test.ts`                                                             |

Every new state-changing request is a `POST`/`DELETE` endpoint or a form action, so the existing origin check (SPEC-SIGN-IN S8) refuses it from another origin; no route is exempt.

## 5. Schema (additive)

| Table                 | Columns                                                                                                                                                                            |
| :-------------------- | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `totp_authenticators` | user_id (pk, → users), secret_sealed (AES-256-GCM, `SECRETS_KEY`), enabled_at (null while set-up waits for the first code), last_used_step (null until a code is used), created_at |
| `recovery_codes`      | id, user_id (→ users), code_hash (SHA-256 hex), created_at, used_at (nullable); index (user_id, code_hash)                                                                         |
| `sign_in_challenges`  | id_hash (pk, SHA-256 of the cookie token), user_id (→ users), step (`code` / `set-up`), created_at, expires_at, ip, user_agent                                                     |

One row per person in `totp_authenticators`: a person has one authenticator. "Two-factor on" means a row with `enabled_at` set. Passkeys (step 2) would be their own table; the challenge's `step` gains a value.

The setting is a row in `settings` (`twoFactorSignIn`: `off` / `admins` / `everyone`), no schema change.

## 6. Routes

| Method    | Path                                     | Guard                       | Does                                                                   |
| :-------- | :--------------------------------------- | :-------------------------- | :--------------------------------------------------------------------- |
| GET, POST | `/login` (changed)                       | public                      | A right password → session, or challenge cookie and redirect to a step |
| GET, POST | `/login/two-factor`                      | public (challenge `code`)   | The code step                                                          |
| GET, POST | `/login/two-factor/set-up`               | public (challenge `set-up`) | The set-up step                                                        |
| POST      | `/setup`, `/invite/[token]` (changed)    | public                      | As today, then a step when required                                    |
| POST      | `/api/account/two-factor/set-up`         | user                        | Starts set-up: key, URI, QR                                            |
| POST      | `/api/account/two-factor`                | user                        | Turns it on: `{ code, password }` → `{ recoveryCodes }`                |
| DELETE    | `/api/account/two-factor`                | user                        | Turns it off: `{ password, code }`                                     |
| POST      | `/api/account/two-factor/recovery-codes` | user                        | New recovery codes: `{ code }` → `{ recoveryCodes }`                   |
| DELETE    | `/api/users/[id=uuid]/two-factor`        | admin                       | Admin reset                                                            |

The step pages are form actions under `PublicPage`; the Account page uses the API client with zod contracts.

## 7. Security notes

- **Key:** 20 random bytes (160 bits, RFC 4226's recommended length), base32 without padding in the URI. HMAC-SHA1, 6 digits, 30 s: what every authenticator app supports. The server's existing `totpCode` (RFC 6238 vectors tested) computes codes. Comparison is constant-time.
- **At rest:** the key is sealed with `sealSecret` (AES-256-GCM, `SECRETS_KEY`), as provider client secrets are. A copied database without `SECRETS_KEY` gives no keys.
- **Recovery codes: SHA-256, not Argon2id.** Each code is 16 characters from the 32-letter code alphabet (80 random bits, shown `XXXX-XXXX-XXXX-XXXX`), made by the server. Argon2id exists to slow guessing of low-entropy passwords; at 80 bits even a fast hash leaves nothing to guess (2^80 SHA-256 is far out of reach), and a fast hash lets sign-in look a code up directly instead of running up to 10 Argon2id checks per attempt, which would also be a cheap way to load the server. Spaces, hyphens and case do not matter when typed.
- **QR code:** made on the server with `qrcode-generator` 2.0.4 (MIT, no dependencies, exact version), error correction M, sent as an SVG path in the JSON reply over the same HTTPS connection that carries the key text. No third-party service, no browser library. Light and dark modules use fixed QR tokens, so the code stays dark-on-light (scannable) in the dark theme.
- **Challenge cookie:** HttpOnly, Secure, SameSite=Lax, path `/login`, 5 minutes, only its hash stored, deleted on use. It is not a session: no guard, hook or socket reads it.
- **Pauses:** code failures share the SPEC-SIGN-IN limits (5 per email in 15 minutes pause 5 minutes; 20 per address in 10 minutes). With the password known, an attacker gets about 5 guesses per 5 minutes against a 3-in-a-million chance each: under 1% a day, and every guess is a `sign-in-failed` with reason `wrong-code` on Activity, which tells the admin the password is known.
- **Break-glass:** "admins can always sign in with a password" still holds: the password is always the first step, and two-factor is in addition. When the phone and recovery codes are both lost, another admin's reset or the host command is the way back.
- **Origin checks:** unchanged and applied to every new endpoint and form action.

## 8. Libraries

- `qrcode-generator` 2.0.4 (QR matrix only; we draw the SVG path ourselves).
- No TOTP library: the RFC 6238 code is already in `src/lib/server/crypto/totp.ts`; base32 is a 20-line encoder in `crypto/base32.ts`.

## 9. Open questions (with recommendations)

1. **Re-check: code instead of the password, or both?** Recommend **instead** (2.7): it is the factor a walk-up person lacks, and the password may be autofilled. Built that way.
2. **Recovery code hashing:** recommend **SHA-256 of 80-bit codes** (section 7). Built that way.
3. **Host commands on installed and Docker servers.** `admin:reset` and `two-factor:reset` need a source checkout: the release bundle and Docker image carry no scripts (SPEC-SERVER-INSTALL lists this as not done). For a Docker server, `docs/hosting.md` documents running the script from a checkout with `DATABASE_PATH` pointing at the volume's `bmuster.db`. Recommend a follow-up spec that bundles a small host-tools entry (`app/host-tools.js`) and exposes both as `bmuster-server reset-password <email>` / `bmuster-server reset-two-factor <email>` and `docker exec <container> node app/host-tools.js …`. Not built here: it changes the release bundle, the image and the Rust launcher, and both commands should move together.
4. **Set-up step lifetime.** The challenge is 5 minutes as decided, which may be short for someone installing an authenticator app first. The pending key lasts an hour (TF9), so signing in again shows the same QR code. Recommend keeping 5 minutes.
5. **Admin reset of another admin:** recommend **allowed** (2.8).
6. **Sessions when the setting is turned on, or after an admin reset:** recommend **left alone**; the requirement applies at the next password sign-in.

## 10. Later: passkeys (step 2)

Not built. Room left: the second step is chosen in one function (`secondStepFor`), the challenge carries a `step`, and a `passkeys` table can sit beside `totp_authenticators`. A passkey would count as "two-factor on" and as an answer to the recent sign-in check.

## 11. As built

Built as specified unless listed here. Version bump and changelog are left for the release step.

**Code**

- Services in `src/lib/server/services/auth/`: `two-factor.ts` (keys, codes, recovery codes, turning on and off, new codes, status), `sign-in-challenges.ts` (the half-signed-in state), `sign-in-steps.ts` (`secondStepFor`, `sessionOrChallenge`, `finishSignIn`: the one place that decides the step after a password), `two-factor-sign-in.ts` (the two step pages), `two-factor-reset.ts` (admin and host reset), `two-factor-qr.ts` (the QR path). `crypto/base32.ts` encodes the key; `crypto/totp.ts` now exports its step length.
- Migration `0024_goofy_mentallo.sql` (generated) adds the three tables.
- Pages: `/login/two-factor`, `/login/two-factor/set-up` (form actions under `PublicPage`); `src/routes/login/sign-in-next.server.ts` sets the session or challenge cookie for `/login`, `/setup` and `/invite/[token]`. Account: `two-factor-panel.svelte`. Shared UI: `src/lib/ui/two-factor-key.svelte`, `src/lib/ui/recovery-codes.svelte`.
- Host command: `scripts/two-factor-reset.ts`, `npm run two-factor:reset -- --email <email>`; documented in `docs/hosting.md` section 7 with `admin:reset`, including the Docker and server-install cases.

**Different from or added to the spec**

- **Pauses everywhere a code or password is typed.** Wrong codes and passwords at the set-up step, on the Account page (turning on, turning off, new codes) and at the recent sign-in check all count toward the SPEC-SIGN-IN pauses and are audited as `sign-in-failed` with a `method` naming where. A paused email or address is refused before anything is checked. A right code at the re-check clears the email's failures, as a right password did.
- **Pending key reuse** (TF9) applies to the Account page's Set up too, not only the set-up step.
- **The sign-in after set-up** is audited as `sign-in` with `method: password, then set up two-factor`.
- **Set-up step page.** After the first code the page shows the recovery codes with an "I have saved my recovery codes" tick box; **Continue** appears once it is ticked. Continue goes through `/login/two-factor`, whose `load` sends a signed-in person on to `returnTo` (so the link goes through `resolve()`). A step page reached without a live challenge says the sign-in timed out (set-up) or sends the person to `/login?timedOut=1`, which says so (code step).
- **Turn off** asks the shared `confirmAction` after the password and code, as the hygiene rule `destructive-request-confirmation` requires for a `DELETE`.
- **Admin reset** is refused (409) for someone without two-factor on, and for the admin's own. **Host reset** accepts any account, on or not (it clears a pending set-up too), and says which.
- **Users page.** `UserView` is unchanged: the page's `load` adds `twoFactorOn` (user id → ISO time) from `twoFactorOnSince`, which keeps the users service from importing the auth service (no import cycle). The Users CSV export does not include two-factor.
- **Recent sign-in.** `SignInCheck` gains `{ kind: 'code' }`; `reconfirmPassword` became `reconfirmSignIn` with a `Recheck` (password or code). The request field is `recheck` (`src/lib/schemas/auth/recheck.ts`) on both endpoints; `confirmWithChecks` takes `recheck: 'none' | 'password' | 'code'` and `ConfirmAnswer` carries `recheck`. `CommandContext` carries `secretsKey` to open the key. A password sent when a code is due (or the other way round) is a wrong answer.
- **Text fields.** `TextField` has a `one-time-code` type: a text box with the phone's number pad (`inputmode="numeric"`).
- **QR colours.** Two fixed tokens, `--qr-light` and `--qr-dark`, keep the code black on white in the dark theme.
- **Setting writes.** `updateSettingAsSystem` takes a transaction, so first-run setup writes the setting in the same transaction as the first admin. `updateSetting` wraps its own.
- **`PAUSED`** moved from `password-sign-in.ts` to `sign-in-limits.ts` so the new modules need not import password sign-in.
- **Tests.** TF13 is also covered in the browser by `run-command.svelte.test.ts` (the dialog asks for a code). TF16's label test is `src/lib/domain/activity/activity.test.ts`. The phone-width overflow tests render the Account panel and the Users badge.

**Needs `npm install`** in an existing checkout for `qrcode-generator`.

**Not done**

- Open question 3: host commands still need a source checkout.
- Passkeys (section 10).

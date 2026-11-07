# SPEC-JOIN: Phone support and the public /join page

**Status:** `IMPLEMENTED (v0.2.0)` · design approved by Jack 2026-11-08 · **Date:** 2026-11-08

> Security work (AGENTS.md, "This tool controls other people's computers"): this adds a public page that hands out a join code, so it touches enrolment. Nothing here weakens an existing check: join codes, enrolment and the agent are unchanged.

## 1. Problem

Adding a machine today means an admin sends a long command to someone, who must paste it into an administrator terminal. For phone support that is hard: the caller is often on a phone while the computer is somewhere else, the command is too long to read out, and nothing warns them that "someone on the phone asked me to install remote access" is also how most remote-access scams start.

Phone support gives the caller a short **support code** to type into a public page, **/join**. The page says plainly who will get access, asks three anti-scam questions, and only then shows the install command.

## 2. The flow

1. **Start phone support.** On Add machine an admin (only admins can add machines, SPEC-ACCESS) clicks **Start phone support**. They get a 6-digit support code (`482 913`), valid for 15 minutes and for one machine, and the address to read out (`bmuster.example.com/join`), both large. The code carries Add machine's join-code options (the machine groups picked there). Behind it is an ordinary single-use join code with the same 15 minutes, so the existing live status shows when it was used. The admin can cancel it.
2. **/join** is public. Without a valid code it only asks for one ("Ask your support person for a code") and shows the organisation name. Nothing else: no machines, no people, no server details.
3. **Who gets access.** With a valid code the page says, large: "**Ada Lovelace** at **Example IT** will be able to see and control this computer, and open its files."
4. **Scam check.** A big plain warning, then three questions with nothing chosen:
   - "Did you contact this person, or are they your workplace's IT?" (Yes / No; safe: Yes)
   - "Has anyone asked you to log in to your bank, buy gift cards, or send money?" (No / Yes; safe: No)
   - "Did someone tell you your computer has a virus or has been hacked?" (No / Yes; safe: No)

   Any unsafe answer shows **Stop. This looks like a scam.** with what to do, and is recorded in Activity. The code stays valid (a legitimate caller who misclicked can be talked back); **Go back** returns to the questions with nothing chosen.

5. **The command.** OS tabs (Windows, Linux, macOS "not available yet"), the detected one chosen; only an OS the server has an agent build for is offered. The existing one-line command with the join code behind the support code (and the certificate pin in local network mode), a big **Copy** button, and simple steps.
6. **After it joins** the page notices (it polls the code) and says "Connected. Ada Lovelace can now help you.", with how to remove the agent later.

## 3. Acceptance criteria

| #   | Criterion                                                                                                                                                                                                                                                                                                    | Test                                                   |
| :-- | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :----------------------------------------------------- |
| J1  | An admin starts phone support: a 6-digit code, unique among recent codes, lasting 15 minutes, backed by a single-use 15-minute join code carrying the chosen machine groups and the admin as its maker. Audited (`support-code-started`). Members are refused.                                               | `support-codes.test.ts`, `guards.test.ts`              |
| J2  | A support code works until it expires, is cancelled, or its join code is used. After the join code is used the code reports "connected" (for up to an hour after it was made) and no longer gives out the command.                                                                                           | `support-codes.test.ts`                                |
| J3  | An admin cancels an open code: the code and its join code stop working at once, the stored join code is wiped, and it is audited (`support-code-cancelled`). A used code cannot be cancelled.                                                                                                                | `support-codes.test.ts`                                |
| J4  | Wrong codes are limited per address and for the whole server (Section 5). A paused attempt is refused before the code is looked at.                                                                                                                                                                          | `support-code-limits.test.ts`, `support-codes.test.ts` |
| J5  | /join and its endpoints expose nothing without a valid code: the page loads only the organisation name; a wrong code gets one fixed message, whether it is unknown, expired, cancelled or used up.                                                                                                           | `join-routes.test.ts`                                  |
| J6  | With a valid code the page names the support person and the organisation, in large type. The first time a code is entered is audited (`support-code-entered`).                                                                                                                                               | `join-flow.svelte.test.ts`, `support-codes.test.ts`    |
| J7  | The scam check: the warning, three questions with no default, Continue only when all three are answered safely; any unsafe answer shows the stop screen at once. The server gives out the command only for three safe answers.                                                                               | `join-flow.svelte.test.ts`, `join-routes.test.ts`      |
| J8  | A stop is recorded in Activity (`support-code-scam-stop`: "A support code was stopped by the scam check"), naming the question; the code stays valid and Go back returns to the questions.                                                                                                                   | `support-codes.test.ts`, `join-flow.svelte.test.ts`    |
| J9  | The command step detects the computer from the user agent (a phone gets Windows and a note to open the page on the computer), offers tabs only for an OS with an agent build (`hasBuildFor`), macOS as "not available yet", the one-line command with the pin in local network mode, Copy, and simple steps. | `phone-support.test.ts`, `join-flow.svelte.test.ts`    |
| J10 | The page polls the code and shows "Connected. <name> can now help you." with the uninstall command for each OS and the local page.                                                                                                                                                                           | `join-flow.svelte.test.ts`, end to end                 |
| J11 | Settings → **Phone support**: **Organisation name** (blank = this server's host name), **Who scammers pretend to be** and **Where to report a scam** (Australian defaults), each saved and audited like any setting.                                                                                         | `settings.test.ts`                                     |
| J12 | Add machine shows Start phone support, the address and code large, the expiry, the live status of the join code ("Used by DESKTOP-ABC") and Cancel (confirmed).                                                                                                                                              | `phone-support.svelte.test.ts`                         |
| J13 | End to end on a scratch server: an admin starts phone support; a second browser with no session enters the code, answers the questions and copies the Linux command; the agent enrols with that join code; /join shows Connected and Add machine shows it used.                                              | Playwright, by hand (Section 9)                        |

## 4. Schema (additive)

| Table                   | Columns                                                                                                                                                                                                                                                       |
| :---------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `support_codes`         | id, code_hash (HMAC-SHA-256 of the 6 digits keyed with `SECRETS_KEY`), join_code_id → join_codes, join_code_sealed (the join code sealed with `SECRETS_KEY`, nullable: wiped on cancel), created_by → users, created_at, expires_at, cancelled_at, entered_at |
| `support_code_failures` | id, address, failed_at (wrong support codes; rows older than a day are deleted)                                                                                                                                                                               |

Join codes keep only a hash, but /join must show the join code itself, so the support code keeps it sealed. The seal is wiped on cancel; after expiry the join code it opens no longer works anyway.

The digits are hashed with a key rather than plain SHA-256 because there are only a million of them: a copy of the database alone must not reveal live codes.

## 5. Guessing limits, and the maths

A support code is 6 digits: 1 000 000 possibilities. Wrong codes (unknown, expired, cancelled or used up, on any /join endpoint) are counted in `support_code_failures`:

- **Per address, within 15 minutes:** the first 3 wrong codes are free. From then on each try must wait 5 seconds longer than the last (5 s after the 3rd, 10 s after the 4th, … 30 s after the 8th). The 10th wrong code pauses that address for 15 minutes.
- **The whole server, within 15 minutes:** 30 wrong codes from all addresses together pause code entry for everyone until the oldest of them is 15 minutes old.

The global limit is what counts against an attacker with many addresses. At most 30 wrong guesses land in any 15 minutes, so at most about 60 can land during one code's 15-minute life. With one code live the chance a guesser hits it is at most 60 / 1 000 000 = 0.006%; with _k_ codes live at once, _k_ times that. Over a busy year of 1 000 support calls, guessing non-stop at the limit the whole time, the chance of ever hitting one is about 1000 × 0.006% = 6%.

What a hit gets: the support person's name and the organisation name, and the install command. It gives no access to any machine. The guesser could add a computer of their own to the server, which the admin sees at once on Add machine ("Used by <their computer>") while waiting for the caller, and the code is then used up for the real caller. That is worth the convenience of 6 digits; longer codes are a poor trade when read over the phone.

The global pause also blocks real callers during an attack. That is deliberate (fail closed); the admin can still add the machine the usual way from Add machine.

## 6. Routes

| Route                            | Guard          | What                                                                                                                                                                   |
| :------------------------------- | :------------- | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/support-codes`        | `route.admin`  | `{ machineGroupIds }` → `{ id, code, expiresAtIso, joinCodeId }`                                                                                                       |
| `DELETE /api/support-codes/<id>` | `route.admin`  | Cancel. 404 unknown, 409 not open.                                                                                                                                     |
| `GET /join`                      | `page.public`  | The page; loads only `{ organisation }`.                                                                                                                               |
| `POST /join/check`               | `route.public` | `{ code }` → `{ kind: 'open', supportPerson, organisation, expiresAtIso }` or `{ kind: 'connected', supportPerson }`; 404 wrong; 429 paused. Also what the page polls. |
| `POST /join/stop`                | `route.public` | `{ code, question }`: records a scam-check stop.                                                                                                                       |
| `POST /join/install`             | `route.public` | `{ code, answers }` (all three safe) → `{ linux, windows }`, each `{ kind: 'ready', command }` or `{ kind: 'none' }`.                                                  |

The public endpoints live under `/join/`, not `/api/`, because every `/api/` route requires a session (`guards.test.ts`). They are POSTs so the code never sits in a URL or a log, and the origin check applies to them as to every write.

## 7. Settings

Section **Phone support** on Settings (new text controls: a box and **Save**):

- **Organisation name** (up to 80 characters). Blank means this server's host name, as people reach it (`bmuster.example.com`).
- **Who scammers pretend to be**, shown in the warning: "Scammers pretend to be from **Microsoft, your bank, the police, the NBN or a computer company**, and ask you to install remote access. …"
- **Where to report a scam**, shown on the stop screen: default "Report it to Scamwatch: https://www.scamwatch.gov.au/report-a-scam, or call ReportCyber on 1300 292 371." Web addresses in it become links.

## 8. Security notes

- The scam check is advice for the caller, not a lock: anyone with a valid code can call `/join/install` with safe answers. The lock is the code itself, its 15 minutes, its one use, and the limits.
- Nothing on /join is shown before a valid code except the organisation name. Every wrong code gets the same message, so the page does not say whether a code ever existed.
- The page sends no cookie and needs no session. `/join` is not behind first-run setup's redirect exception, so it is unreachable until the server has an admin.
- Audited: started, cancelled, first entered (with the caller's address), stopped by the scam check.

## 9. Testing end to end (J13)

A scratch production build on a spare port with its own `DATABASE_PATH`, `RELEASES_PATH` (a fake agent build so Linux shows), `SECRETS_KEY` and first admin; Playwright drives an admin browser and a second browser with no session; the scratch agent enrols with `bmuster-agent enrol --url … --code <join code> --data-dir <scratch>` (install needs root). Screenshots of every step at 390 and 1280 px, light and dark.

## 10. Open questions

None.

## As built (v0.2.0)

Recovered the interrupted implementation and added browser journey tests and phone-support control tests. The caller sees the support person's name, completes the three questions, and receives commands only for available agent builds. The server checks the safe answers too. Codes are single use, expire after 15 minutes, and are rate limited. Failed cancellation leaves the active code visible so it can be retried.

The warning advises independent verification for unexpected calls rather than claiming legitimate companies never make unsolicited calls. The warning is guidance; possession of the support code remains the authorisation boundary.

An isolated HTTP/browser smoke test created a support code as an admin, completed the public flow without signing in, enrolled a test identity and observed Connected. A used code was refused by the install endpoint. Existing development data and installed services were not used by the tests. The additive 0012 migration was recovered from the interrupted worktree without editing its SQL.

### Layout refinement (v0.2.1)

The public join flow uses the shared public frame at up to 48rem wide, rather than the compact 26rem sign-in width. The support-code entry stays compact; the card widens after the code is accepted. Phone gutters and safe-area insets remain owned by the frame. The code input displays the digits in two groups of three with a clear gap.

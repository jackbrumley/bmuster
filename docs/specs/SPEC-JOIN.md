# SPEC-JOIN: Enrolment codes and the public /join page

**Status:** `IMPLEMENTED (v0.2.0; Add machine wording updated in v0.3.1; enrolment wording 2026-11-11)` · design approved by Jack 2026-11-08 · **Date:** 2026-11-08

> Security work (AGENTS.md, "This tool controls other people's computers"): this adds a public page that hands out a join code, so it touches enrolment. Nothing here weakens an existing check: join codes, enrolment and the agent are unchanged.

## 1. Problem

Adding a machine today means an admin sends a long command to someone, who must paste it into an administrator terminal. That is hard when the admin is not at the computer: the person there may be on a phone while the computer is somewhere else, the command is too long to read out, and nothing warns them that "someone asked me to install remote access" is also how most remote-access scams start.

BMuster is a fleet management tool, so the answer is enrolment, not a support session: the admin gives the person at the computer a short **enrolment code** to enter on a public page, **/join**. Entering it installs the BMuster agent, which registers the computer with the organisation's BMuster server so it is managed from then on. The page says plainly who will get access, asks three anti-scam questions, and only then shows the install command.

## 2. The flow

1. **Create an enrolment code.** On Add machine an admin (only admins can add machines, SPEC-ACCESS) creates a 6-digit enrolment code (`482 913`), valid for 15 minutes and for one machine. The page shows the address (`bmuster.example.com/join`) and code. The code carries the selected machine groups. Behind it is an ordinary single-use join code with the same 15 minutes, so the existing live status shows when it was used. The admin can cancel it. The enrolment code is the primary Add machine method; manual install is available below it for an admin who can run a command on the target computer.
2. **/join** is public. Without a valid code it only asks for one ("Add this computer to Example IT", a short explanation that enrolling installs the BMuster agent so the computer is registered and managed, and "Your IT administrator gives you the enrolment code") and shows the organisation name. Nothing else: no machines, no people, no server details.
3. **Who gets access.** With a valid code the page says, large: "After enrolment, people at **Example IT** with access, such as **Ada Lovelace** who made this code, can see and control this computer and open its files."
4. **Scam check.** A big plain warning, then three questions with nothing chosen:
   - "Did this code come from your workplace's IT, or from someone you contacted yourself?" (Yes / No; safe: Yes)
   - "Has anyone asked you to log in to your bank, buy gift cards, or send money?" (No / Yes; safe: No)
   - "Did someone tell you your computer has a virus or has been hacked?" (No / Yes; safe: No)

   Any unsafe answer shows **Stop. This looks like a scam.** with what to do, and is recorded in Activity. The code stays valid (someone legitimate who misclicked can be talked back); **Go back** returns to the questions with nothing chosen.

5. **The command.** OS tabs (Windows, Linux, macOS "can’t be enrolled yet"), the detected one chosen; only an OS the server has an agent build for is offered. The existing one-line command with the join code behind the enrolment code (and the certificate pin in local network mode), a big **Copy** button, and simple steps.
6. **After it enrols** the page notices (it polls the code) and says "Enrolled. This computer is now managed by Example IT.", that people at Example IT with access (such as Ada Lovelace) can now see and control it, and how to remove the agent later. An expired code while waiting says "This enrolment code has run out. Ask Ada Lovelace for a new one."

## 3. Acceptance criteria

| #   | Criterion                                                                                                                                                                                                                                                                                                        | Test                                                         |
| :-- | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :----------------------------------------------------------- |
| J1  | An admin creates an enrolment code: a 6-digit code, unique among recent codes, lasting 15 minutes, backed by a single-use 15-minute join code carrying the chosen machine groups and the admin as its maker. Audited (`support-code-started`). Members are refused.                                              | `support-codes.test.ts`, `guards.test.ts`                    |
| J2  | An enrolment code works until it expires, is cancelled, or its join code is used. After the join code is used the code reports "connected" (for up to an hour after it was made) and no longer gives out the command.                                                                                            | `support-codes.test.ts`                                      |
| J3  | An admin cancels an open code: the code and its join code stop working at once, the stored join code is wiped, and it is audited (`support-code-cancelled`). A used code cannot be cancelled.                                                                                                                    | `support-codes.test.ts`                                      |
| J4  | Wrong codes are limited per address and for the whole server (Section 5). A paused attempt is refused before the code is looked at.                                                                                                                                                                              | `support-code-limits.test.ts`, `support-codes.test.ts`       |
| J5  | /join and its endpoints expose nothing without a valid code: the page loads only the organisation name; a wrong code gets one fixed message, whether it is unknown, expired, cancelled or used up.                                                                                                               | `join-routes.test.ts`                                        |
| J6  | With a valid code the page names the code's maker and the organisation, in large type. The first time a code is entered is audited (`support-code-entered`).                                                                                                                                                     | `join-flow.svelte.test.ts`, `support-codes.test.ts`          |
| J7  | The scam check: the warning, three questions with no default, Continue only when all three are answered safely; any unsafe answer shows the stop screen at once. The server gives out the command only for three safe answers.                                                                                   | `join-flow.svelte.test.ts`, `join-routes.test.ts`            |
| J8  | A stop is recorded in Activity (`support-code-scam-stop`: "An enrolment code was stopped by the scam check"), naming the question; the code stays valid and Go back returns to the questions.                                                                                                                    | `support-codes.test.ts`, `join-flow.svelte.test.ts`          |
| J9  | The command step detects the computer from the user agent (a phone gets Windows and a note to open the page on the computer), offers tabs only for an OS with an agent build (`hasBuildFor`), macOS as "can’t be enrolled yet", the one-line command with the pin in local network mode, Copy, and simple steps. | `phone-support.test.ts`, `join-flow.svelte.test.ts`          |
| J10 | The page polls the code and shows "Enrolled. This computer is now managed by <organisation>." with the uninstall command for each OS and the local page.                                                                                                                                                         | `join-flow.svelte.test.ts`, end to end                       |
| J11 | Settings → **Enrolment page**: **Organisation name** (blank = this server's host name), **Who scammers pretend to be** and **Where to report a scam** (Australian defaults), each saved and audited like any setting.                                                                                            | `settings.test.ts`                                           |
| J12 | Add machine leads with the **Enrolment code** panel, before the secondary Manual install panel; it shows the address and code large, the expiry, live join-code status and confirmed Cancel.                                                                                                                     | `add-machine.svelte.test.ts`, `phone-support.svelte.test.ts` |
| J13 | End to end on a scratch server: an admin creates an enrolment code; a second browser with no session enters the code, answers the questions and copies the Linux command; the agent enrols with that join code; /join shows Enrolled and Add machine shows it used.                                              | Playwright, by hand (Section 9)                              |

## 4. Schema (additive)

| Table                   | Columns                                                                                                                                                                                                                                                       |
| :---------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `support_codes`         | id, code_hash (HMAC-SHA-256 of the 6 digits keyed with `SECRETS_KEY`), join_code_id → join_codes, join_code_sealed (the join code sealed with `SECRETS_KEY`, nullable: wiped on cancel), created_by → users, created_at, expires_at, cancelled_at, entered_at |
| `support_code_failures` | id, address, failed_at (wrong enrolment codes; rows older than a day are deleted)                                                                                                                                                                             |

Join codes keep only a hash, but /join must show the join code itself, so the enrolment code keeps it sealed. The seal is wiped on cancel; after expiry the join code it opens no longer works anyway.

The digits are hashed with a key rather than plain SHA-256 because there are only a million of them: a copy of the database alone must not reveal live codes.

## 5. Guessing limits, and the maths

An enrolment code is 6 digits: 1 000 000 possibilities. Wrong codes (unknown, expired, cancelled or used up, on any /join endpoint) are counted in `support_code_failures`:

- **Per address, within 15 minutes:** the first 3 wrong codes are free. From then on each try must wait 5 seconds longer than the last (5 s after the 3rd, 10 s after the 4th, … 30 s after the 8th). The 10th wrong code pauses that address for 15 minutes.
- **The whole server, within 15 minutes:** 30 wrong codes from all addresses together pause code entry for everyone until the oldest of them is 15 minutes old.

The global limit is what counts against an attacker with many addresses. At most 30 wrong guesses land in any 15 minutes, so at most about 60 can land during one code's 15-minute life. With one code live the chance a guesser hits it is at most 60 / 1 000 000 = 0.006%; with _k_ codes live at once, _k_ times that. Over a busy year of 1 000 enrolments, guessing non-stop at the limit the whole time, the chance of ever hitting one is about 1000 × 0.006% = 6%.

What a hit gets: the code maker's name and the organisation name, and the install command. It gives no access to any machine. The guesser could add a computer of their own to the server, which the admin sees at once on Add machine ("Used by <their computer>") while waiting for the real computer to enrol, and the code is then used up for it. That is worth the convenience of 6 digits; longer codes are a poor trade when read over the phone.

The global pause also blocks real enrolments during an attack. That is deliberate (fail closed); the admin can still add the machine the usual way from Add machine.

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

Section **Enrolment page** on Settings (new text controls: a box and **Save**):

- **Organisation name** (up to 80 characters). Blank means this server's host name, as people reach it (`bmuster.example.com`).
- **Who scammers pretend to be**, shown in the warning: "Scammers pretend to be from **Microsoft, your bank, the police, the NBN or a computer company**, and ask you to install remote access. …"
- **Where to report a scam**, shown on the stop screen: default "Report it to Scamwatch: https://www.scamwatch.gov.au/report-a-scam, or call ReportCyber on 1300 292 371." Web addresses in it become links.

## 8. Security notes

- The scam check is advice for the person at the computer, not a lock: anyone with a valid code can call `/join/install` with safe answers. The lock is the code itself, its 15 minutes, its one use, and the limits.
- Nothing on /join is shown before a valid code except the organisation name. Every wrong code gets the same message, so the page does not say whether a code ever existed.
- The page sends no cookie and needs no session. `/join` is not behind first-run setup's redirect exception, so it is unreachable until the server has an admin.
- Audited: started, cancelled, first entered (with the address it came from), stopped by the scam check.

## 9. Testing end to end (J13)

A scratch production build on a spare port with its own `DATABASE_PATH`, `RELEASES_PATH` (a fake agent build so Linux shows), `SECRETS_KEY` and first admin; Playwright drives an admin browser and a second browser with no session; the scratch agent enrols with `bmuster-agent enrol --url … --code <join code> --data-dir <scratch>` (install needs root). Screenshots of every step at 390 and 1280 px, light and dark.

## 10. Open questions

None.

## Wording (2026-11-11)

The page and its admin side first spoke as though /join were a quick-support tool: "Get help from Example IT", "support code", "Install the helper", "Connected. Ada Lovelace can now help you." That was wrong. BMuster is a fleet management tool, and /join enrols the computer: it installs the BMuster agent and registers the computer with the organisation's server, which then manages it. Jack asked for the wording to say what actually happens.

Every user-visible string now talks about enrolment: the page title is "Enrol this computer · BMuster", the heading "Add this computer to <organisation>", the code an **enrolment code** from the IT administrator, the install step "Install the BMuster agent", and the last step "Enrolled. This computer is now managed by <organisation>." The who-gets-access sentence stays explicit (people at the organisation with access, naming the code's maker, can see and control the computer and open its files), and the scam check and stop screen stay, reworded for enrolment, because enrolling still grants control. On the admin side the Add machine panel is **Enrolment code**, the Settings section is **Enrolment page**, and Activity says "Created an enrolment code", "Cancelled an enrolment code", "An enrolment code was entered on /join" and "An enrolment code was stopped by the scam check".

Wording only: routes (`/join`, `/api/support-codes`), tables, columns, setting keys, audit kinds and internal names are unchanged. Audit rows written before the change keep their old targets.

## As built (v0.2.0)

Recovered the interrupted implementation and added browser journey tests and Add machine control tests. The person at the computer sees the code maker's name, completes the three questions, and receives commands only for available agent builds. The server checks the safe answers too. Codes are single use, expire after 15 minutes, and are rate limited. Failed cancellation leaves the active code visible so it can be retried.

The warning advises independent verification for unexpected calls rather than claiming legitimate companies never make unsolicited calls. The warning is guidance; possession of the enrolment code remains the authorisation boundary.

An isolated HTTP/browser smoke test created a code as an admin, completed the public flow without signing in, enrolled a test identity and observed the finished state. A used code was refused by the install endpoint. Existing development data and installed services were not used by the tests. The additive 0012 migration was recovered from the interrupted worktree without editing its SQL.

### Layout refinement (v0.2.1)

The public join flow uses the shared public frame at up to 48rem wide, rather than the compact 26rem sign-in width. The code entry stays compact; the card widens after the code is accepted. Phone gutters and safe-area insets remain owned by the frame. The code input displays the digits in two groups of three with a clear gap.

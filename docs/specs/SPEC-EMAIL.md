# SPEC-EMAIL: SMTP and email

**Status:** `IMPLEMENTED` (E1–E8 built; version bump and changelog left for the release step) · approved 2026-11-07 · **Date:** 2026-11-07 · Build after SPEC-SIGN-IN (it needs settings, users and the audit log).

## 1. Problem

BMuster cannot send email, so a person with a password account who forgets it needs an admin, invitations cannot be emailed, and nobody hears when something goes wrong (a machine goes offline, an update rolls back). Modelled on the Wannon portal's email settings, trimmed to SMTP only.

## 2. Acceptance criteria

| #   | Criterion                                                                                                                                                                                                                                                                                                                                   | Test                      |
| :-- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | :------------------------ |
| E1  | An admin sets up email on Settings → Email: on/off, from name, from address, SMTP host, port, security (STARTTLS, implicit TLS, none), username and password. The password is sealed with `SECRETS_KEY`, write-only, shown only as Set / Not set.                                                                                           | `email-settings.test.ts`  |
| E2  | _Send a test email_ sends to an address the admin types and shows the server's reply or the exact error.                                                                                                                                                                                                                                    | `email-settings.test.ts`  |
| E3  | Emails go through a durable queue: retried with back-off (1 min doubling to 1 h, 8 tries), and failures are visible to admins. Nothing is lost on restart.                                                                                                                                                                                  | `email-queue.test.ts`     |
| E4  | _Forgot password_ on the sign-in page emails a single-use link (30 minutes) to password accounts only. The page says the same thing whether or not the address exists. Provider-linked accounts are told to use their provider.                                                                                                             | `password-reset.test.ts`  |
| E5  | Inviting a user sends an invitation email when email is set up; otherwise the admin gets a link to pass on.                                                                                                                                                                                                                                 | `invitations.test.ts`     |
| E6  | A notification capability, kept small: events from a catalogue go through one notification service, and **notification rules** (admin page) decide who hears about which. A rule is: an event kind, a scope (any machine, a machine group, or one machine), and recipients (a user group or a list of addresses). Nothing is on by default. | `notifications.test.ts`   |
| E7  | Every email has a plain text and an HTML part from one template, in the BMuster style, with no tracking.                                                                                                                                                                                                                                    | `email-templates.test.ts` |
| E8  | Sent and failed emails are recorded (recipient, subject, time, result), never the body of password-reset mail.                                                                                                                                                                                                                              | `email-queue.test.ts`     |

## 3. Settings (in `settings-definitions.ts`)

`email.enabled`, `email.fromName`, `email.fromAddress`, `email.smtpHost`, `email.smtpPort` (587), `email.smtpSecurity` (`starttls`), `email.smtpUsername`, `email.smtpPassword` (sealed), plus the `notification_rules` table (id, event kind, scope, recipients, enabled, created by).

## 4. Notifications: first events and what is left out

- **First events in the catalogue:** share link created, share link opened (a session started from it), share link ended early, and a _test notification_ to check a rule.
- **Easy to add later:** each new event is one catalogue entry (name, description, what it carries) and one call where it happens; rules and delivery need no change.
- **Not included:** machine offline alerts. Machines on the road go offline all the time; instead the console keeps everything known before a machine went offline (last check-in, last signed-in user, last inventory) so it can be read at any time.
- **Later channels** (Teams, Slack, webhooks) plug into the same rules as another delivery method.

## 5. Library

`@upyo/core` and `@upyo/smtp` 0.6.0, as the portal uses. Only SMTP at first; API providers (Resend, Mailgun) can be added later as other transports.

## 6. Decisions (2026-11-07)

1. SMTP only at first; email is the only channel for now.
2. No machine-offline alerts; last-known information is kept instead.
3. Rules list email addresses until user groups exist (SPEC-ACCESS); then they can name a user group.
4. First events: machine enrolled, machine removed, test notification. Share-link events come with share links.
5. Invitation links set a password and last 7 days; provider accounts are told to sign in with their provider.

## 7. As built

- **Settings** live in the settings table under `email.*` keys, declared in `src/lib/domain/settings/email-settings-definitions.ts` (the portal's shape, SMTP only) rather than in `settings-definitions.ts`: they save together from one form, and the generic list stays as it was. Security is `starttls` (refuses to send without TLS), `tls` (implicit) or `none`.
- **Console address** (`email.consoleUrl`) was added. Every link in an email starts with it, never with the request's Host header, which a stranger controls (reset-link poisoning). Email cannot be turned on without it, a from address and a server.
- **Pages:** Settings has Email and Notifications tabs (`/settings/email`, `/settings/notifications`), so the console menu is unchanged. Forgot password is `/login/forgot`, a reset link `/login/reset/<token>`, an invitation `/invite/<token>`.
- **Queue:** `email_messages`. A body holding a password link is sealed with `SECRETS_KEY` while it waits; every body is wiped once the message is sent or given up. The test email is recorded and audited too. A worker started from `init` runs every 15 seconds and at once after a request queues mail. While email is off, messages wait and are not counted as tries.
- **Notifications:** events are written to an outbox (`notification_events`) in the same transaction as the change, so the raising code needs neither the rules nor the queue (and no import cycle). The worker matches them against enabled rules; each address gets one email per event. Events raised while email is off are dropped. The test notification is a **Send test** button on a rule, not an event a rule picks. User groups exist, so a rule names a user group or a list of addresses.
- **Invitations:** adding a user asks how they sign in: Invite (emailed, or a link for the admin while email is off), a password now, or provider only (emailed how to sign in). Someone who has never signed in and has no password can be sent a new invitation; earlier links stop working. Accepting signs the person in.
- **Forgot password:** at most one email per address every 2 minutes; disabled accounts get nothing; a new link cancels the old one; a reset ends every session of the account, and the person then signs in again.
- **Audit kinds added:** `email-sent`, `email-failed`, `password-reset-requested`, `password-reset`, `invitation-created`, `invitation-accepted`, `notification-rule-added`, `-changed`, `-deleted`.
- **Tests:** `src/lib/server/services/settings/email-settings.test.ts` (E1, E2), `services/email/email-queue.test.ts` (E3, E8), `services/auth/password-reset.test.ts` (E4), `services/users/invitations.test.ts` (E5), `services/notifications/notifications.test.ts` (E6), `services/email/email-templates.test.ts` (E7), plus browser tests beside the pages. They send through an in-process SMTP sink (`tests/helpers/smtp-sink.ts`), never a real server.

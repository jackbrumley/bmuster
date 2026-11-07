# SPEC-EMAIL: SMTP and email

**Status:** `DRAFT` · **Date:** 2026-11-07 · Build after SPEC-SIGN-IN (it needs settings, users and the audit log).

## 1. Problem

BMuster cannot send email, so a person with a password account who forgets it needs an admin, invitations cannot be emailed, and nobody hears when something goes wrong (a machine goes offline, an update rolls back). Modelled on the Wannon portal's email settings, trimmed to SMTP only.

## 2. Acceptance criteria

| #   | Criterion                                                                                                                                                                                                                                         | Test                      |
| :-- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | :------------------------ |
| E1  | An admin sets up email on Settings → Email: on/off, from name, from address, SMTP host, port, security (STARTTLS, implicit TLS, none), username and password. The password is sealed with `SECRETS_KEY`, write-only, shown only as Set / Not set. | `email-settings.test.ts`  |
| E2  | _Send a test email_ sends to an address the admin types and shows the server's reply or the exact error.                                                                                                                                          | `email-settings.test.ts`  |
| E3  | Emails go through a durable queue: retried with back-off (1 min doubling to 1 h, 8 tries), and failures are visible to admins. Nothing is lost on restart.                                                                                        | `email-queue.test.ts`     |
| E4  | _Forgot password_ on the sign-in page emails a single-use link (30 minutes) to password accounts only. The page says the same thing whether or not the address exists. Provider-linked accounts are told to use their provider.                   | `password-reset.test.ts`  |
| E5  | Inviting a user sends an invitation email when email is set up; otherwise the admin gets a link to pass on.                                                                                                                                       | `invitations.test.ts`     |
| E6  | Alerts, each switched on or off in Settings → Email and sent to the admins (or a list of addresses): machine offline longer than a set time, agent update rolled back, new machine enrolled, admin signed in from a new address.                  | `email-alerts.test.ts`    |
| E7  | Every email has a plain text and an HTML part from one template, in the BMuster style, with no tracking.                                                                                                                                          | `email-templates.test.ts` |
| E8  | Sent and failed emails are recorded (recipient, subject, time, result), never the body of password-reset mail.                                                                                                                                    | `email-queue.test.ts`     |

## 3. Settings (in `settings-definitions.ts`)

`email.enabled`, `email.fromName`, `email.fromAddress`, `email.smtpHost`, `email.smtpPort` (587), `email.smtpSecurity` (`starttls`), `email.smtpUsername`, `email.smtpPassword` (sealed), `email.alerts.*`.

## 4. Library

`@upyo/core` and `@upyo/smtp` 0.6.0, as the portal uses. Only SMTP at first; API providers (Resend, Mailgun) can be added later as other transports.

## 5. Open questions

1. Should alerts also go to a webhook (Teams, Slack, ntfy) later, or is email enough?
2. Default offline-alert time: 30 minutes?

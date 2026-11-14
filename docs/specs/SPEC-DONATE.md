# SPEC-DONATE: a humble donation reminder

**Status:** `DRAFT` · decided by Jack 2026-11-14 · **Date:** 2026-11-14

## 1. Problem

BMuster is free and made by one person. Some of the people running it would happily give back, but nothing in the console tells them they can. A reminder must stay humble: it never blocks, slows or covers any work, never appears on the computers being supported, and never tells anyone (including the project) whether someone donated.

## 2. Behaviour

- **Who:** admins only. Never members, never share-link guests.
- **Where:** only the console's Machines page (the landing list), as a slim line at the bottom of the page content. Not a pop-up, not fixed over content. Never on machine pages, desktop, terminal, full screen or pop-out, and never on the managed computers (no agent change).
- **When it starts:** once the server has been in use for 14 days **and** at least one machine is enrolled. "In use since" is the earliest console account's creation time (the first admin, made at setup); before anyone has signed up there is nothing to show.
- **Answers:**
  - **Donate** opens `https://bmuster.com/donate` in a new tab (`target="_blank"`, `rel="external noopener noreferrer"`). It records nothing; the reminder stays until answered.
  - **Not now** hides it for 5 days.
  - **I've donated, thank you** hides it for 90 days.
- **Wording:**
  - First time: "BMuster is free and made by one person. If it saves you time, please consider a small donation."
  - After a "Not now": the same, then "If BMuster supports your business, please consider giving back."
  - Once someone has said they donated (even if a "Not now" came after): "Thanks for supporting BMuster. Still finding it useful?" before the first sentence.
- **State** is one server setting (per server, not per browser) in the existing `settings` key-value table, under the key `donate.reminder`. It is not one of the Settings page's editable settings. Only an admin-only route changes it, and every change is audited as `setting-changed` on "Donation reminder" with who, when, and the answer.

## 3. Acceptance criteria

| #   | Criterion                                                                                                                                                                  | Test                                                                             |
| :-- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :------------------------------------------------------------------------------- |
| D1  | Only admins get a reminder; a member never does, whatever the dates.                                                                                                       | `donate-reminder.test.ts` (domain), `machines-donate.test.ts`                    |
| D2  | Hidden until the server has been in use for 14 days, and while no machine is enrolled; hidden when no account exists yet.                                                  | `donate-reminder.test.ts` (domain), `machines-donate.test.ts`                    |
| D3  | "Not now" hides it for 5 days; it comes back after, with the "giving back" line added.                                                                                     | `donate-reminder.test.ts` (domain and service), `donate-reminder.svelte.test.ts` |
| D4  | "I've donated, thank you" hides it for 90 days; it comes back after with the thank-you wording first, and keeps thanking after a later "Not now".                          | `donate-reminder.test.ts` (domain and service), `donate-reminder.svelte.test.ts` |
| D5  | `POST /api/settings/donate-reminder` is admin-only (401 signed out, 403 member, 400 for an unknown answer) and records who and when in the audit log.                      | `donate-reminder-route.test.ts`                                                  |
| D6  | The state is a server setting in the existing settings store (no migration), and a stored value of the wrong shape fails loudly rather than acting as some other value.    | `donate-reminder.test.ts` (service)                                              |
| D7  | It is only ever rendered by the Machines page: no other route, layout or component imports it.                                                                             | `machines-donate.test.ts`                                                        |
| D8  | Donate is a link to `https://bmuster.com/donate` with `target="_blank"` and `rel="external noopener noreferrer"`; the console makes no request about donations on its own. | `donate-reminder.svelte.test.ts`                                                 |
| D9  | It sits in the page flow at the bottom of the content (not fixed), keyboard reachable, and renders on a 360px phone in light and dark themes without sideways scrolling.   | `phone-overflow-donate.svelte.test.ts`, `donate-reminder.svelte.test.ts`         |
| D10 | After an answer the line hides at once; if the server refuses, a toast says why and the line stays.                                                                        | `donate-reminder.svelte.test.ts`                                                 |

## 4. Routes

| Method | Path                            | Guard | Body                                   | Reply                       |
| :----- | :------------------------------ | :---- | :------------------------------------- | :-------------------------- |
| POST   | `/api/settings/donate-reminder` | admin | `{ "answer": "not-now" \| "donated" }` | `{ "answered": "not-now" }` |

No schema change: one more key in the `settings` table, and the existing `setting-changed` audit kind.

## 5. Website

- `https://bmuster.com/donate` (`docs/donate.md`): short and humble. GitHub Sponsors and PayPal (one-off or monthly, AUD). Says BMuster sends nothing to anyone: the reminder is built into the software, it does not check whether you donated, and "I've donated" is on your honour.
- A Donate link in the site footer, a short "Support BMuster" note in the home page's open-source section, and a "Support" section in `README.md`.

## 6. Security and privacy notes

- **No telemetry.** The console never makes a network request about donations; only the person's own click opens the donate page, in a new tab with no opener or referrer.
- The answer route is admin-only through the standard guard and origin check, takes a closed set of answers checked with zod, and is audited. It changes nothing but the reminder's own setting.
- Nothing about the reminder reaches members, guests, the agent or the managed computers.

## 7. Open questions

None. Decided by Jack on 2026-11-14.

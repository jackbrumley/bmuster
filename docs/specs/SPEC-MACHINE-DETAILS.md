# SPEC-MACHINE-DETAILS: Name, description and notes

**Status:** `APPROVED` (2026-11-07) · **Date:** 2026-11-07 · Build after SPEC-SIGN-IN (it needs users for authors and the audit log).

## 1. Problem

A machine's name comes from enrolment and cannot be changed, and there is nowhere to record what a machine is for or what has been done to it.

## 2. Acceptance criteria

| #   | Criterion                                                                                                                                                            | Test                           |
| :-- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :----------------------------- |
| D1  | An admin renames a machine (1–80 characters) from its page; the new name shows everywhere at once.                                                                   | `machine-details.test.ts`      |
| D2  | An admin sets a description (up to 500 characters, plain text), shown under the name on the machine page and searchable on Machines.                                 | `machine-details.test.ts`      |
| D3  | The machine page has a Notes tab: a list of notes, newest first, each with its author, time and text (up to 10 000 characters, plain text, line breaks kept).        | `machine-notes.test.ts`        |
| D4  | Anyone who can see the machine can add a note. The author can edit their note; the author or an admin can delete it (with confirmation). Edited notes show "edited". | `machine-notes.test.ts`        |
| D5  | Renames, description changes and note deletions go to the audit log.                                                                                                 | `audit.test.ts`                |
| D6  | The Machines list search covers name, hostname, description and operating system.                                                                                    | `machines-page.svelte.test.ts` |

## 3. Schema (additive)

| Table           | Columns                                                                                       |
| :-------------- | :-------------------------------------------------------------------------------------------- |
| `machines`      | + `description` (text, default '')                                                            |
| `machine_notes` | id, machine_id, author_user_id, body, created_at, edited_at (nullable), deleted_at (nullable) |

## 4. Routes

| Method        | Path                                          | Guard                        |
| :------------ | :-------------------------------------------- | :--------------------------- |
| PATCH         | `/api/machines/[id=uuid]` (name, description) | admin                        |
| GET, POST     | `/api/machines/[id=uuid]/notes`               | user who can see the machine |
| PATCH, DELETE | `/api/machines/[id=uuid]/notes/[noteId=uuid]` | author; DELETE also admin    |

## 5. Decisions (2026-11-07)

1. **Notes are plain text** first; Markdown can come later.
2. **Admins rename machines and edit descriptions** for now; anyone who can see the machine can add notes.

## 6. Open questions

1. Should a later release let a note be pinned to the top (e.g. "Do not reboot during business hours")?

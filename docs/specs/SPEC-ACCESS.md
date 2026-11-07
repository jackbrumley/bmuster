# SPEC-ACCESS: User groups, machine groups and access rules

**Status:** `APPROVED` (2026-11-07) · Design: `docs/access-and-sign-in.md` section 1.

## 1. Problem

Groups and access rules are prototype pages with made-up data, so members see no machines. This spec makes them real.

## 2. Acceptance criteria

| #   | Criterion                                                                                                                                                                                                                                                                                                                                                           | Test                               |
| :-- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | :--------------------------------- |
| A1  | Admins create, rename, describe and delete **user groups**, and add or remove members (Users page and the group's page).                                                                                                                                                                                                                                            | `user-groups.test.ts`              |
| A2  | Admins create, rename, describe and delete **machine groups**, and add or remove machines (the group's page and each machine's Manage tab).                                                                                                                                                                                                                         | `machine-groups.test.ts`           |
| A3  | A built-in **All machines** group always contains every machine; it cannot be deleted, renamed or edited by hand.                                                                                                                                                                                                                                                   | `machine-groups.test.ts`           |
| A4  | Admins create, edit and delete **access rules**: one user group, one machine group, permissions (`view`, `terminal`, `desktop-view`, `desktop-control`, `files`, `share-links`; every other permission includes `view`, `desktop-control` includes `desktop-view`), and consent (`unattended` or `ask`; new rules take the _Default for new access rules_ setting). | `access-rules.test.ts`             |
| A5  | One access service answers "what may this person do on this machine": admins everything; members the union of matching rules; consent unattended if any rule giving that permission says so.                                                                                                                                                                        | `access.test.ts`                   |
| A6  | Members see only machines where they have `view`: Machines list, machine pages, join-code status links, Activity entries about those machines. Other machine pages return 404 for them, not 403.                                                                                                                                                                    | `access.test.ts`, `guards.test.ts` |
| A7  | A join code can name machine groups; the machine joins them when it enrols (Add machine has a group picker; roll-out codes too).                                                                                                                                                                                                                                    | `join-codes.test.ts`               |
| A8  | Deleting a group used by a rule asks first and deletes those rules too (named in the confirmation). Deleting a user or machine group never removes users or machines.                                                                                                                                                                                               | `access-rules.test.ts`             |
| A9  | Every change to groups, memberships and rules is audited.                                                                                                                                                                                                                                                                                                           | `audit.test.ts`                    |
| A10 | The prototype data for groups and rules is gone; `src/lib/prototype/` holds nothing these pages use.                                                                                                                                                                                                                                                                | review, dead-code check            |

## 3. Schema (additive)

| Table                   | Columns                                                                                  |
| :---------------------- | :--------------------------------------------------------------------------------------- |
| `user_groups`           | id, name (unique), description, created_at                                               |
| `user_group_members`    | user_group_id, user_id (pk both)                                                         |
| `machine_groups`        | id, name (unique), description, built_in (`all` or null), created_at                     |
| `machine_group_members` | machine_group_id, machine_id (pk both); not stored for _All machines_                    |
| `access_rules`          | id, user_group_id, machine_group_id, permissions (json), consent, created_at, created_by |

## 4. Out of scope

Provider group sync; share links; notifications naming user groups arrive with SPEC-EMAIL's rules once this exists.

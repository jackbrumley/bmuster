# SPEC-CSV-EXPORT: CSV export on every list

**Status:** `DRAFT` · asked for 2026-11-07 · **Date:** 2026-11-07

## 1. Problem

Admins need lists out of BMuster for audits, asset registers and outside parties: machines, users, groups, access rules and activity (`docs/concept.md`, Later). Copying from the screen is slow, and the Machines list only draws rows as you scroll. An export is also a way to take data out of the server, so it must respect the viewer's access and be audited like any other read of note.

## 2. Acceptance criteria

| #   | Criterion                                                                                                                                                                                                                                                                                                  | Test                                                           |
| :-- | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :------------------------------------------------------------- |
| X1  | Machines, Users, Groups, Access rules and Activity each have an **Export** button (secondary, download icon) in the page header. On Machines it sits next to the Cards / Table switch, and the header still wraps cleanly at 390px.                                                                        | `export-button.svelte.test.ts`, `machines-page.svelte.test.ts` |
| X2  | Each export is a server `GET` that answers `text/csv; charset=utf-8` with `Content-Disposition: attachment; filename="bmuster-<list>-<YYYY-MM-DD>.csv"`, UTF-8 with a byte order mark so Excel reads it correctly, lines ending CRLF.                                                                      | `exports.test.ts`                                              |
| X3  | Cells follow RFC 4180: a cell with a comma, quote, CR or LF is quoted, and quotes inside are doubled.                                                                                                                                                                                                      | `csv.test.ts`                                                  |
| X4  | **Injection guard:** a text cell that starts with `=`, `+`, `-`, `@`, tab or CR gets a leading `'`, so a spreadsheet never runs it as a formula. Numbers are written as numbers.                                                                                                                           | `csv.test.ts`                                                  |
| X5  | An export holds only what the viewer may see, through the same access service the page uses: a member's Machines export lists only machines they can see and leaves out machine group names; their Activity export only entries about those machines. Users, Groups and Access rules are admin-only (403). | `exports.test.ts`, `guards.test.ts`                            |
| X6  | Machines exports **every** machine matching the current search and filter (not just the rows drawn so far), in the order on screen: the table's sort in Table view, the list order in Cards view.                                                                                                          | `exports.test.ts`, `machines-page.svelte.test.ts`              |
| X7  | Activity exports newest first, up to 100 000 rows, with time in ISO (UTC) and in the viewer's time zone, and takes an optional date range. When there are more, the last line says the export was cut off and how to get the rest.                                                                         | `exports.test.ts`                                              |
| X8  | Every export is audited (`list-exported`): who, which list, how many rows, and the search, filter, sort and date range used.                                                                                                                                                                               | `exports.test.ts`                                              |

## 3. Columns

| List         | Columns                                                                                                                                             |
| :----------- | :-------------------------------------------------------------------------------------------------------------------------------------------------- |
| Machines     | Name, Host, Status, OS, OS version, CPU %, Memory %, Disk % (fullest), Last user, Last seen (ISO), Groups (admins only), Agent version, Description |
| Users        | Name, Email, Role, Sign-in method, Groups, Last sign-in (ISO), Disabled                                                                             |
| Groups       | Name, Kind (People / Machines), Member count, Members                                                                                               |
| Access rules | Who (group of people), What machines (group of machines), Permissions, Consent                                                                      |
| Activity     | Time (ISO), Time (local, `<zone>`), Actor, Action, Target, IP, Details                                                                              |

Lists inside a cell (groups, members, permissions) are joined with `; `. An unknown figure is an empty cell.

## 4. Routes

| Method | Path                        | Guard | Query                                                                                |
| :----- | :-------------------------- | :---- | :----------------------------------------------------------------------------------- |
| GET    | `/api/exports/machines`     | user  | `search`, `filter` (`all` · `online` · `offline` · `attention`), `sort`, `direction` |
| GET    | `/api/exports/users`        | admin | none                                                                                 |
| GET    | `/api/exports/groups`       | admin | none                                                                                 |
| GET    | `/api/exports/access-rules` | admin | none                                                                                 |
| GET    | `/api/exports/activity`     | user  | `timeZone` (IANA name), `from`, `to` (ISO times, optional)                           |

No schema change: the audit log gains one kind, `list-exported`.

## 5. Security notes

- Read-only, but it moves data off the server in bulk: the same access checks as the pages (`visibleMachineIds`, `activityScopeFor`, admin guards), never a browser-supplied list.
- The filters only narrow what the access check allows; no parameter widens it.
- Formula injection is guarded (X4); the file is served as an attachment with `Cache-Control: no-store` and `X-Content-Type-Options: nosniff`.

## 6. Open questions

1. Activity has no search, filter or date range on the page today. The export takes `from` and `to` so a later filter bar can pass them through; the button exports everything the viewer may see, newest first, up to the cap. Should Activity get a date-range picker?
2. Users, Groups and Access rules have no search, filter or sort on screen, so their exports follow the page order.

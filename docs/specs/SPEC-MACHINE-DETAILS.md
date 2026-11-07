# SPEC-MACHINE-DETAILS: Name, description and notes

**Status:** `IMPLEMENTED` (D1–D9 built; version bump and changelog left for the release step) · approved 2026-11-07 · **Date:** 2026-11-07

## 1. Problem

A machine's name comes from enrolment and cannot be changed, and there is nowhere to record what a machine is for or what has been done to it. As built so far: the agent's commands and _Remove machine_ (typed confirmation) live on the machine's **Manage** tab, kept off Overview because they are rarely needed.

## 2. Acceptance criteria

| #   | Criterion                                                                                                                                                                                                                                                                                                                                                                                                                     | Test                                                 |
| :-- | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :--------------------------------------------------- |
| D1  | An admin renames a machine (1–80 characters) from its page; the new name shows everywhere at once.                                                                                                                                                                                                                                                                                                                            | `machine-details.test.ts`                            |
| D2  | An admin sets a description (up to 500 characters, plain text), shown under the name on the machine page and searchable on Machines.                                                                                                                                                                                                                                                                                          | `machine-details.test.ts`                            |
| D3  | The machine page has a Notes tab: a list of notes, newest first, each with its author, time and text (up to 10 000 characters, plain text, line breaks kept).                                                                                                                                                                                                                                                                 | `machine-notes.test.ts`                              |
| D4  | Anyone who can see the machine can add a note. The author can edit their note; the author or an admin can delete it (with confirmation). Edited notes show "edited".                                                                                                                                                                                                                                                          | `machine-notes.test.ts`                              |
| D5  | Renames, description changes and note deletions go to the audit log.                                                                                                                                                                                                                                                                                                                                                          | `audit.test.ts`                                      |
| D6  | The Machines list search covers name, hostname, description and operating system.                                                                                                                                                                                                                                                                                                                                             | `machines-page.svelte.test.ts`                       |
| D7  | The machine keeps its **last signed-in user** and when they were last seen, even after they sign out or the machine goes offline; Overview and the Machines list show it ("Last user: sarah.k, 2 days ago").                                                                                                                                                                                                                  | `machine-details.test.ts`                            |
| D8  | The agent reports every graphics card (GPUs, integrated and discrete): name, vendor, video memory where known, driver version where known. Overview shows them under System ("Graphics: NVIDIA RTX 4070 (12 GB), Intel UHD 770"); none reported shows "None reported". Linux reads `/sys/class/drm` and PCI ids; Windows asks WMI (`Win32_VideoController`).                                                                  | `inventory` tests (agent), `machine-details.test.ts` |
| D9  | The Manage tab has **Reinstall agent**: it makes a join code tied to this machine (single use, 60 minutes) and shows the install commands. Enrolling with it takes over this machine's entry — same id, name, description, notes, groups and history — with the new key; the old key is refused from then on. Audited as a reinstall. Plain join codes always make a new machine; there is no automatic matching by hardware. | `reinstall.test.ts`                                  |

## 3. Schema (additive)

| Table            | Columns                                                                                            |
| :--------------- | :------------------------------------------------------------------------------------------------- |
| `machines`       | + `description` (text, default ''), + `last_user_name`, + `last_user_seen_at` (nullable)           |
| (inventory JSON) | + `gpus: [{ name, vendor, memoryBytes: { kind: 'unknown' } \| { kind: 'known', bytes }, driver }]` |
| `machine_notes`  | id, machine_id, author_user_id, body, created_at, edited_at (nullable), deleted_at (nullable)      |

## 4. Routes

| Method        | Path                                          | Guard                        |
| :------------ | :-------------------------------------------- | :--------------------------- |
| PATCH         | `/api/machines/[id=uuid]` (name, description) | admin                        |
| GET, POST     | `/api/machines/[id=uuid]/notes`               | user who can see the machine |
| PATCH, DELETE | `/api/machines/[id=uuid]/notes/[noteId=uuid]` | author; DELETE also admin    |

## 5. Decisions (2026-11-07)

3. **Reinstalling a machine** uses a Reinstall code from its Manage tab (D9). No automatic hardware matching: a hardware ID can be faked by anyone with a join code, so taking over an entry must be an admin's explicit choice.

1. **Notes are plain text** first; Markdown can come later.
1. **Admins rename machines and edit descriptions** for now; anyone who can see the machine can add notes.

## 6. Open questions

1. Should a later release let a note be pinned to the top (e.g. "Do not reboot during business hours")?

## 7. As built (2026-11-07)

Built as specified unless listed here. Tested end to end against a scratch dev server with the debug agent (enrol, run, reinstall into a second data folder).

| #      | Where                                                                                                                                                                                                                                                                        | Tests                                                     |
| :----- | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :-------------------------------------------------------- |
| D1, D2 | **Details** panel with **Edit details** (modal: name, description) at the top of the **Manage** tab, so Overview stays uncluttered. The description shows under the name and hostname in the machine header, line breaks kept. `PATCH /api/machines/<id>` takes both fields. | `machine-details.test.ts`                                 |
| D3, D4 | **Notes** tab between Files and Manage: an Add a note box, then the notes newest first with author, relative time (full time on hover) and "edited". Edit opens a modal; Delete asks with `confirmAction`.                                                                   | `machine-notes.test.ts`, `notes-tab.svelte.test.ts`       |
| D5     | Audit kinds `machine-renamed` (detail: from), `machine-description-changed` (detail: the new text), `machine-note-deleted` (detail: author and the note's first 80 characters), in the same transaction as the change. Saving unchanged values records nothing.              | `audit.test.ts`                                           |
| D6     | Search placeholder "Search name, host, description or system"; the rule is `matchesSearch` in `domain/machines/machine.ts`.                                                                                                                                                  | `machines-page.svelte.test.ts`                            |
| D7     | Updated at every check-in that reports a user; a check-in with nobody signed in leaves it. Overview: "Last user: <name>, <time>" (or "None seen yet"); the Machines card shows the same line small, only when known.                                                         | `machine-details.test.ts`, `machines-page.svelte.test.ts` |
| D8     | Agent `src/gpus.rs`. Overview System: "Graphics: AMD Radeon RX 7900 XT/7900 XTX/7900M (20 GB), AMD Raphael (512 MB)" or "None reported"; memory of 1 GB or more is rounded to whole GB.                                                                                      | agent `gpus::…` tests, `machine-details.test.ts`          |
| D9     | **Reinstall agent** panel on Manage: Make a reinstall code → the code, its expiry, the live join code status, the one-line command, and a manual download and command for the machine's own build, all with the certificate pin in local network mode.                       | `reinstall.test.ts`                                       |

**Different from the spec or decided while building**

- **Routes.** The existing `api/machines/[id]` folder was kept (not renamed to `[id=uuid]`); an id that is not a machine's answers 404. Notes are under `api/machines/[id]/notes` and `…/notes/[noteId=uuid]`. New: `POST /api/machines/[id]/reinstall-code` (admins) returns the same shape as `POST /api/join-codes`.
- **Who sees a machine.** `services/access/access.ts` `canSeeMachine(user, machineId)` is the one check, used by the notes routes and the Notes tab; until SPEC-ACCESS it is "admins". Notes routes use `route.user` plus that check, so they widen with the access rules. The author check (edit) and author-or-admin check (delete) are in `machine-notes.ts`.
- **Schema.** One additive migration (`0004`): `machines.description` (default ''), `last_user_name`, `last_user_seen_at`; `machine_notes` (index on machine and time); `join_codes.reinstall_machine_id`, without a foreign key because `machines` already references `join_codes` and machine rows are never deleted.
- **Names and limits.** A name is trimmed, 1–80 characters, one line. A description is trimmed, up to 500 characters, line breaks allowed. A note is trimmed, 1–10 000 characters. All plain text, never rendered as HTML. `TextField` gained a `multiline` type (a textarea) for these.
- **GPUs on the wire.** `gpus: [{ name, vendor, memoryBytes: { kind: 'unknown' } | { kind: 'known', bytes }, driver }]` is required from this agent; the server's zod schema defaults a missing `gpus` to `[]`, so inventories from older agents read as "None reported" (SPEC-ENROLMENT As built).
- **Linux GPUs.** Every `/sys/class/drm/cardN` (connectors and render nodes skipped) whose `device` has PCI `vendor` and `device` ids; firmware frame buffers (simpledrm) have none and are skipped; a PCI device is listed once. Names come from `/usr/share/misc/pci.ids` or `/usr/share/hwdata/pci.ids`: the vendor's short name plus the bracketed marketing name ("NVIDIA GeForce RTX 4070"); `vendor` is the list's full vendor name. Without the list: "NVIDIA device 0x2786" for NVIDIA, AMD and Intel, else "Vendor 0x1234 device 0x5678". Memory from `mem_info_vram_total` (amdgpu, including an APU's carve-out). Driver: the `driver` link's name, plus `/sys/module/<driver>/version` when present ("nvidia 550.54.14"). Only regular files are opened, with `O_NONBLOCK`; a test proves named pipes in every read position do not block.
- **Windows GPUs.** `Win32_VideoController` through the `wmi` crate (=0.18.4, no default features; COM, no child process). Software adapters (`SWD\…`, `ROOT\…` device ids) are skipped. `AdapterRAM` is 32-bit and caps near 4 GB, so memory comes from the driver key's `HardwareInformation.qwMemorySize` (via `windows-registry` =0.6.1, which shares the `windows-*` crates already in the build), falling back to `AdapterRAM` only when it is below the cap. Type-checked and clippy-clean for `x86_64-pc-windows-gnu`; not yet run on a real Windows machine.
- **Reinstall takeover.** In the enrolment transaction: new `public_key`, `last_request_ms` 0, hostname, OS family, target and agent version from the new enrolment, `enrolled_at` and `last_seen_at` now, `join_code_id` the reinstall code (so its status shows "Used by <machine>"). Name, description, notes, last user and audit history stay. `machine_status` and `machine_inventory` rows are deleted, so Overview waits for the new agent's first check-in. Audited `machine-reinstalled` (actor System, hostname and system). After the commit any live socket for that machine id is closed with 4001 `revoked`, so a running old copy stops; its later requests fail the key check with `bad-signature`.
- **Removed meanwhile.** A reinstall code for a removed machine is refused with `invalid-code` and "The machine this reinstall code was made for has been removed from the server. Add it again with a new join code." (no new refusal reason, so older agents understand it); the use is not consumed. Making a reinstall code for a removed machine answers 404.
- Reinstall uses the machine's own OS family for the commands; moving a machine to another OS means removing it and adding it again.
- Making a reinstall code is not audited (plain join codes are not either); its use is.

**Not done**

- Version bump and changelog (there is no `src/lib/changelog.ts` yet); left for the release step, as with SPEC-SIGN-IN.
- The Windows GPU code has not run on Windows.

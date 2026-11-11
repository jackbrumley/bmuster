# SPEC-STORAGE: Where the disk space went

**Status:** `APPROVED, building phase 1` · draft 2026-11-11, approved by Jack the same day ("go", then "build that into this release too") · **Security work** (AGENTS.md: the agent channel, and folder names are sensitive). Phase 1 is detailed below; phases 2 and 3 are sketched and **not in this phase**.

## 0. Open questions (decided)

All decided 2026-11-11, Jack approved the draft. Each was the recommendation in the draft.

| #   | Question                                                                              | Decided                                                                                                                                                                                                                                                                                                                                |
| :-- | :------------------------------------------------------------------------------------ | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Q1  | Which permission lets a person see the Storage tab?                                   | **`files`**, the same as the Files tab. Folder names are as sensitive as the folders themselves; no new permission.                                                                                                                                                                                                                    |
| Q2  | Should every rescan skip folders that have not changed (by their modified time)?      | **No, every pass walks everything.** A folder's modified time does not change when a file in it grows, so skipping would hide the commonest cause (a growing log). Fast change-tracking (the NTFS change journal, fanotify) is later work.                                                                                             |
| Q3  | Should a pass that is cut off (restart, update, shut-down) carry on where it stopped? | **No, it starts again.** A pass is paced to finish in about an hour on a typical machine; the last complete scan stays visible while the next one runs. Resuming adds a checkpoint format for little gain. Revisit if laptops never finish a pass.                                                                                     |
| Q4  | Should the scanner pause while a remote desktop or terminal session is open?          | **No.** It runs at the lowest CPU and disk priority the system has, so a person's work (and a session's) always comes first.                                                                                                                                                                                                           |
| Q5  | Which drives are scanned?                                                             | **Local fixed drives only.** Windows: fixed drives (`DRIVE_FIXED`). Linux: `/` and the real local mounts the Files tab lists, without network file systems (NFS, SMB/CIFS, sshfs) and without removable media under `/media` and `/run/media`.                                                                                         |
| Q6  | Sizes: bytes on disk or the file's length?                                            | **Bytes on disk where it is free to read**: Linux uses allocated blocks (sparse files count what they use); hard-linked files count once. Windows uses the length (what Explorer shows); cloud placeholders (OneDrive "online only") count 0. `C:\Windows\WinSxS` shows larger than it is (hard links), as in Explorer and WinDirStat. |
| Q7  | Can a person start a scan now?                                                        | **Yes: Rescan now**, for people with `files`; audited (`storage-rescan-requested`). It runs at the same low priority, with less pausing.                                                                                                                                                                                               |
| Q8  | Where does the scan data live, and in what format?                                    | **On the machine, in a compact file of our own** (one per drive, under `<data>/storage/`), not SQLite. See section 4.                                                                                                                                                                                                                  |
| Q9  | Should the Machines list show the per-drive summary now?                              | **No, phase 3.** Phase 1 stores it and shows it on the Storage tab when the machine is offline.                                                                                                                                                                                                                                        |

## 1. Problem

The commonest helpdesk call is a full disk: a person filled it, or a service did (logs, caches, update leftovers, a backup that went to the wrong drive). Finding where the space went today means a remote session and a tool like WinDirStat, which takes minutes to walk the disk while you wait, and may not run at all when the disk is completely full. Sysadmins supporting hundreds of machines need the answer waiting for them.

## 2. Phases

1. **Phase 1, this build:** a background scanner on each agent, a **Storage** tab beside Files to browse its results (drives → biggest folders → drill down; largest files; freshness; progress), and a small per-drive summary sent to the server with each check-in.
2. **Phase 2, not in this phase:** one-click clean-up of a fixed per-OS list of known-safe items (section 11).
3. **Phase 3, not in this phase:** full-disk alerts (section 12).

## 3. Behaviour (phase 1)

### 3.1 When the scanner runs

- **The first pass** starts 10 minutes after the agent starts, so it never competes with start-up.
- **Rescans:** a new pass starts when the oldest complete scan of a scanned drive is more than 24 hours old (checked every minute), or when someone asks for one (Rescan now). Only one pass runs at a time (an exclusive lock on `<data>/storage/scan.lock`, released by the system if the scanner dies).
- **One pass walks every scanned drive in turn** and replaces each drive's scan when that drive is finished, so a pass cut off part-way keeps the drives it finished.
- **Every pass walks the whole drive** (Q2). A cut-off pass starts again at the next due time (Q3).

### 3.2 Staying out of the way

- **Its own process at the lowest priority.** The scanner is `bmuster-agent storage-scan --data-dir <dir>`, started by the agent. At start it lowers itself: Linux `setpriority` nice 19 and `ioprio_set` class idle; Windows `SetPriorityClass(PROCESS_MODE_BACKGROUND_BEGIN)` (lowest CPU, disk and memory priority). It is single-threaded.
- **Where it runs (Linux, installed):** as the transient service `bmuster-storage-scan.service` (SPEC-SESSION-UNITS), because the agent's own sandbox has a private `/tmp` and `/var/tmp` and the scan would miss them. The unit runs as root with no network (`PrivateNetwork=yes`). Without `--sessions systemd` (development, Windows), it is a plain child process of the agent. When the agent stops, it stops the scanner (the unit, or the child); the start-up sweep stops one an earlier run left.
- **Pacing:** it works in slices and sleeps 4 times as long as each slice took (about 20 % of one core at most, less in practice because it mostly waits on the disk). Rescan now sleeps as long as it worked (about 50 %).
- **Pauses** (checked every 30 seconds, polled between folders): on battery power (the power module's reading), and while the machine's CPU is above 70 % (measured over 5 seconds). It carries on when they clear.

### 3.3 What it walks and skips

- **Never follows links**: symbolic links, Windows junctions and other reparse points are counted as the link itself, not walked.
- **Stays on its drive:** on Linux a folder on another device (another mount) is skipped; that mount is scanned as its own drive if it qualifies (Q5). `/proc`, `/sys`, `/dev` and `/run` are always skipped.
- **Errors are counted, never fatal:** a folder it may not read adds to `denied` and the walk carries on. The space it could not see shows as "Not scanned" (used space minus what the scan counted).
- **Read only:** the scanner opens folders for listing and reads metadata. It never opens a file's contents, never changes access times on purpose, and writes only under `<data>/storage/`.

### 3.4 Full disks and crash-safe writes

- A drive's scan is written to `<drive key>.scan.tmp` (owner-only), flushed to disk, then renamed over `<drive key>.scan`. A half-written scan never replaces the last complete one; a stray `.tmp` is deleted at the next pass.
- When saving fails (the data folder's disk is full), the last complete scan stays, the failure is recorded in `<data>/storage/state.json` and shown on the tab ("The last scan could not be saved: …"). On Linux the scanner runs as root and so can use the file system's reserved blocks.
- Reading never needs free space, so a completely full disk can still be browsed from the last scan.

## 4. Data model (on the machine)

**Where:** `<data>/storage/` (`/var/lib/bmuster/storage`, `C:\ProgramData\BMuster\storage`), owner-only like the rest of the data folder.

- `<key>.scan`: one drive's last complete scan. `<key>` is the first 16 hex digits of the SHA-256 of the drive's mount path.
- `state.json`: the pass now running (`{ kind: 'scanning', mount, startedAtMs, scannedBytes, usedBytes }`, rewritten at most every 10 seconds) or idle, plus the last problem.
- `rescan`: an empty file that asks for a pass now; the scheduler deletes it when it starts the pass.

**What a scan holds (bounded):**

- A header: format version, mount path, started and finished times, the drive's size and used bytes at the time, counted bytes, files, folders, denied folders.
- **Folder totals, not files:** each kept folder has its name, total bytes, file count, the bytes of its own files, and how many small folders were folded into it and their bytes.
- **Folding:** a finished folder below the threshold (1 MiB to start) is folded into its parent: its bytes and counts are added there and the folder itself is dropped. If more than **100,000** folders are kept, the threshold is multiplied by 4 and the kept tree is folded again. A drive's scan is therefore at most 100,000 folders (a few MB) whatever the disk holds.
- **The 1,000 largest files** on the drive (path, bytes, modified time).
- A SHA-256 of everything before it, checked on reading; a damaged file reads as "never scanned" and is logged.

**Why our own format and not SQLite (Q8):** the agent has no SQLite today, and `rusqlite` with bundled SQLite adds a C build for every target (including the cross-built Windows agent) and about 1.5 MB. A scan is written once and replaced whole; reading needs only "this folder's children" and "the largest files under this folder", which a loaded tree answers directly. Atomic replacement is a rename, and the size bound is the folding rule. Incremental updates, the main reason for a database, are not in phase 1 (Q2).

## 5. Reading it live (the agent channel)

Storage reuses the person's **files session** (SPEC-FILES): the same signed ticket with purpose `files`, the same per-request permission check on the server, the same agent-side check that only a `files` ticket runs these ops. The ops are answered by the same request code (in the files helper on Linux), which reads the scan files; nothing walks the disk on request.

| Op (server → agent)                    | Result                                                                                                                                                                                                     |
| :------------------------------------- | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `storage-summary`                      | `{ drives: DriveSummary[], problem }`. Each drive: mount, live size and free bytes, the last complete scan (or none) and whether a pass is scanning it now (with a percent).                               |
| `storage-folder {mount, path, offset}` | The folder's total, file count, own files' bytes, folded small folders, and its kept sub-folders biggest first, **200 per page** from `offset`, with `more`. At the drive's root also "Not scanned" bytes. |
| `storage-largest {mount, path}`        | The largest files under `path` from the drive's 1,000, biggest first, **at most 100**.                                                                                                                     |
| `storage-rescan`                       | Asks for a pass now (writes `rescan`). `{}`                                                                                                                                                                |

- `path` is the full absolute path of a kept folder; the agent applies the Files path rules (absolute, no `..`). A path the scan does not hold (folded, or never scanned) is `not-found`.
- Errors use the Files codes (`invalid`, `not-found`, `io`).

**HTTP routes** (all `route.user`, thin; each checks `view` and `files` on every request through the access service, as Files does):

| Route                                                         | Does                      |
| :------------------------------------------------------------ | :------------------------ |
| `GET  /api/machines/[id]/storage/summary`                     | `storage-summary`         |
| `GET  /api/machines/[id]/storage/folder?mount=&path=&offset=` | `storage-folder`          |
| `GET  /api/machines/[id]/storage/largest?mount=&path=`        | `storage-largest`         |
| `POST /api/machines/[id]/storage/rescan`                      | `storage-rescan`, audited |

## 6. Per-drive summary to the server

- The check-in gains `storage`: `{ kind: 'unreported' }` (older agents, the default) or `{ kind: 'reported', drives: DriveSummary[] }`, the same drive summary as `storage-summary` without folder data. A few hundred bytes; it is not part of the inventory hash.
- The server keeps the latest one per machine in **`machine_storage`** (additive): `machine_id` (primary key, references machines), `drives` (JSON text), `reported_at` (ms).
- The Storage tab shows it when the machine is offline ("Last reported …"). Phase 3 reads it for alerts.

## 7. UI: the Storage tab

A tab **Storage** (icon `IconChartDonut`) after Files on the machine page. Without `files` it shows `NoPermission`; offline it shows `EmptyState` with the last reported drives (if any) beneath.

- **Drives** (a `ListCard` of `ListRow`s): each drive with a `UsageBar` (used of size), free space, and its scan line: "Scanned 3 h ago", "Scanning… 42 %", or "Not scanned yet". A **Rescan now** button (`Button`, `RadarSpinner` while asking) sits above the list in a small bar with the last problem (`Notice`) if any.
- **A drive's folders:** tapping a drive opens its root. A breadcrumb row (scrolls sideways at phone width) leads back. Below, a `Panel` with the folder's total and file count, then a `ListCard`: one row per sub-folder, biggest first, with name, size, percent of this folder and a thin bar; then "Files in this folder" and "N small folders" rows (not tappable); at the drive's root also "Not scanned (system or no access)". Tapping a folder drills in. "Show more" loads the next 200. Each folder row has an "Open in Files" link to the same folder in the Files tab.
- **Largest files:** a `SegmentedControl` switches the list between **Folders** and **Largest files** (under the current folder): name, folder, size, modified date.
- **Freshness** above the folder list: "From the scan finished 3 h ago" (relative, with the exact time as a title), so nobody mistakes it for live.
- **States:** never scanned → `EmptyState` "Not scanned yet. The first scan starts about 10 minutes after the agent starts, and builds slowly in the background." with the progress if running; scanning with no complete scan → `EmptyState` with "Scanning… N %"; loading → `LoadingVeil`.
- Phone first (one column, rows at least 40 px), the same layout widened on desktop; tokens only, so light and dark both work.

## 8. Acceptance criteria (phase 1)

| #   | Criterion                                                                                                                                                                                                  | Test                                                 |
| :-- | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :--------------------------------------------------- |
| S1  | The walk totals a folder tree correctly (bytes, files, folders), counts a hard-linked file once (Linux), never follows a link, and counts an unreadable folder in `denied` and carries on.                 | agent `storage::walk` tests                          |
| S2  | The walk stays on its device and skips `/proc`, `/sys`, `/dev` and `/run`.                                                                                                                                 | agent `storage::walk` tests                          |
| S3  | Folders under the threshold fold into their parent; more than the folder cap raises the threshold and folds again; at most 1,000 largest files are kept, biggest first.                                    | agent `storage::walk` tests                          |
| S4  | A scan file round-trips; a damaged or truncated file is refused; saving goes through a temporary file and a rename, so a failed save leaves the previous scan.                                             | agent `storage::store` tests                         |
| S5  | `storage-folder` pages children biggest first (200 a page) and reports folded and not-scanned bytes; `storage-largest` filters to the folder; unknown paths are `not-found`; relative paths are `invalid`. | agent `storage::query` tests, protocol `files` tests |
| S6  | A pass is due 10 minutes after start, when a drive's scan is older than 24 h, or when `rescan` exists; never while one runs.                                                                               | agent `storage::schedule` tests                      |
| S7  | The scanner pauses on battery and while the CPU is busy, and paces itself (sleeps 4× its work, 1× on Rescan now).                                                                                          | agent `storage::pace` tests                          |
| S8  | The check-in carries `storage`; older agents' check-ins still parse; the server keeps the latest per machine.                                                                                              | protocol tests, `check-in.test.ts`                   |
| S9  | Every storage request checks `view` and `files` on the server (404, 403, 503 offline) and runs on the files session (a `files` ticket on the agent). Rescan now is audited.                                | `storage.test.ts`                                    |
| S10 | The Storage tab: drives with usage and scan freshness; drill down and breadcrumbs; largest files; never-scanned, scanning and offline (last reported) states; no permission.                               | `storage-tab.svelte.test.ts`                         |
| S11 | The Linux scan unit runs `storage-scan` as `bmuster-storage-scan.service` with no network; the sweep stops a leftover one.                                                                                 | agent `exec::unit` tests                             |

## 9. Schema changes

One additive table, `machine_storage` (section 6), generated with `npm run db:generate`.

## 10. Security notes

- **Who sees folder names:** only people with `files` on the machine (Q1), checked on the server on every request and on the agent by the ticket's purpose. Admins always.
- **Paths stay on the machine.** Folder names and file paths leave it only in answer to a signed, permission-checked request; the check-in summary has mount paths and byte counts only. The server stores no folder names and logs none. Browsing is not audited (as Files listing is not); Rescan now is.
- **The scanner is read-only and confined:** runs as the agent's account (root or SYSTEM), never follows links out of a drive, never opens file contents, writes only in `<data>/storage/` (owner-only files), and on Linux has no network.
- **Nothing new on the wire:** the ops are new names on the existing files session; the ticket, signature, single use and permission checks are unchanged.

## 11. Phase 2: one-click clean-up (not in this phase)

- A fixed, per-OS list of known-safe items, compiled into the agent (for example: Windows `C:\Windows\Temp`, each profile's `AppData\Local\Temp`, Windows Update download cache, Delivery Optimization cache, crash dumps, the Recycle Bin; Linux `/var/tmp` and `/tmp` files older than 7 days, the package caches of apt, dnf and pacman, rotated logs `*.gz` / `*.1` under `/var/log`, the systemd journal above a size).
- Each item is sized first, shown with a tick box, confirmed with `confirmAction`, and audited with the bytes freed. Nothing outside the fixed list can be deleted this way; the server sends only item ids, never paths.
- Permission: `files` on that machine.

## 12. Phase 3: full-disk alerts (not in this phase)

- A drive over 90 % used shows on the Machines list (from `machine_storage`), then an email through the existing notifications.

## 13. Not in this version

Change-tracking rescans (NTFS change journal, fanotify); resuming a cut-off pass; network drives; macOS; per-user (non-admin) views.

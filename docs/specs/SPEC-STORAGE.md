# SPEC-STORAGE: Where the disk space went

**Status:** phase 1 (S1–S11) `IMPLEMENTED (v0.4.17)`; phases 2 and 3 (S12–S24) `IMPLEMENTED (v0.4.18)` · draft 2026-11-11, approved by Jack the same day ("go", then "build that into this release too"; phases 2 and 3: "Do all storage phases"); version bump and changelog left for the release step · **Security work** (AGENTS.md: the agent channel, folder names are sensitive, and phase 2 **deletes files on other people's computers**).

## 0. Open questions (decided)

Decided (2026-11-11, Jack approved the draft). Each answer was the draft's recommendation.

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
2. **Phase 2:** clean-up of a fixed per-OS list of known-safe items, sized first, ticked, confirmed and audited (section 11).
3. **Phase 3:** full-disk alerts on the Machines list, the machine page and by email (section 12).

## 3. Behaviour (phase 1)

### 3.1 When the scanner runs

- **The first pass** starts 10 minutes after the agent starts, so it never competes with start-up.
- **Rescans:** a new pass starts when the oldest complete scan of a scanned drive is more than 24 hours old (checked every minute), or when someone asks for one (Rescan now). Only one pass runs at a time (an exclusive lock on `<data>/storage/scan.lock`, released by the system if the scanner dies).
- **Rescan now is prompt** (added after testing 0.4.17: on Fedora a click "didn't feel like it actually acted", because the scheduler looked once a minute and the tab refreshed every 30 seconds). The scheduler wakes every half second and starts an asked-for pass at once (S25). While a pass already runs, nothing is asked and the answer says so (`{ alreadyScanning: true }`; an older agent answers `{}`, read as asked) (S26). The tab shows "Asking <machine> to scan…" with a small spinner in place of the button at once, reads the drives every 2 seconds until a pass runs or a newer scan finished, then returns to the 30-second refresh; after 60 seconds without a start it says "The machine has not started the scan yet; it will when it can." (not an error). Already scanning shows "Already scanning, N %." (S27).
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

- A drive's scan is written to `<key>.tmp` (owner-only), flushed to disk, then renamed over `<drive key>.scan`. A half-written scan never replaces the last complete one; a stray `.tmp` is deleted at the next pass.
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

## 11. Phase 2: clean-up of known-safe items

**Security work.** This deletes files on other people's computers, as root or SYSTEM. It is **not a general delete**: the agent holds a fixed, compiled-in list of items per operating system; the server and the browser send only item **ids**, never a path, a pattern or a command. Everything an item touches is decided on the machine from its id.

### 11.1 Decided

| #   | Question                                | Decided                                                                                                                                                                                                                                   |
| :-- | :-------------------------------------- | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Q10 | Who may clean up?                       | **`files`** on that machine, as for the tab (Jack, 2026-11-11). Checked on the server on every request and on the agent by the ticket's purpose.                                                                                          |
| Q11 | How is a clean-up confirmed?            | Each item shows its size first, is ticked, and **Clean up** asks with `confirmAction`, naming every ticked item and the total.                                                                                                            |
| Q12 | What can it delete?                     | Only the items in 11.2, only inside each item's own folders, never through a link. Nothing else, whatever the request says.                                                                                                               |
| Q13 | How many at once?                       | **One clean-up per machine at a time** (a lock on the machine; a second start is refused as busy).                                                                                                                                        |
| Q14 | Age rules                               | `/var/tmp`: files not accessed, changed or modified for 30 days. Windows temporary folders: 7 days, as Windows' own Disk Clean-up. Everything else: no age rule.                                                                          |
| Q15 | Windows Update cache: stop the service? | **No.** Files Windows Update holds open are skipped and counted; stopping `wuauserv` could break an update that is installing.                                                                                                            |
| Q16 | What is audited?                        | `storage-cleanup-started` (who, which items) when it starts, and `storage-cleanup` (items, bytes freed, files removed and skipped, errors, finished or interrupted) when the server learns the result, from the tab or the next check-in. |

### 11.2 The items

Each item has an id, a label and an explanation (in the console), how it is **sized** (shown before anything is ticked) and how it is **cleaned**. An item that does not apply to the machine (no `apt` and no `dnf`, no Flatpak, the other operating system) is not offered.

**Windows**

| Id                            | Label                        | Sized                                                                                                                 | Cleaned                                                                                                                                       |
| :---------------------------- | :--------------------------- | :-------------------------------------------------------------------------------------------------------------------- | :-------------------------------------------------------------------------------------------------------------------------------------------- |
| `windows-user-temp`           | Temporary files of each user | Files older than 7 days in each profile's `AppData\Local\Temp` (profiles under `%SystemDrive%\Users`)                 | Safe sweep (11.3); files in use skipped                                                                                                       |
| `windows-temp`                | Windows temporary files      | Files older than 7 days in `%SystemRoot%\Temp`                                                                        | Safe sweep                                                                                                                                    |
| `windows-update-cache`        | Windows Update downloads     | All files in `%SystemRoot%\SoftwareDistribution\Download`                                                             | Safe sweep; files in use skipped (Q15)                                                                                                        |
| `delivery-optimisation-cache` | Delivery Optimisation cache  | All files in `%SystemRoot%\ServiceProfiles\NetworkService\AppData\Local\Microsoft\Windows\DeliveryOptimization\Cache` | Safe sweep                                                                                                                                    |
| `windows-crash-dumps`         | Crash dumps                  | `%SystemRoot%\Minidump`, `%SystemRoot%\MEMORY.DMP`, and each profile's `AppData\Local\CrashDumps`                     | Safe sweep                                                                                                                                    |
| `recycle-bins`                | Recycle Bins                 | Everything in `X:\$Recycle.Bin` on each fixed drive, except each person's own folder and `desktop.ini`                | Safe sweep, keeping the per-person folders                                                                                                    |
| `component-store`             | Windows component clean-up   | Unknown upfront: "frees an unknown amount, can take several minutes"                                                  | `%SystemRoot%\System32\Dism.exe /Online /Cleanup-Image /StartComponentCleanup` (2 h limit); freed = the drive's free space after minus before |

**Linux**

| Id                  | Label                      | Sized                                                                                                                          | Cleaned                                                                                                             |
| :------------------ | :------------------------- | :----------------------------------------------------------------------------------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------ |
| `package-cache`     | Package downloads          | `*.deb` under `/var/cache/apt/archives` (with `apt-get`); `*.rpm` under `/var/cache/dnf` and `/var/cache/libdnf5` (with `dnf`) | `apt-get clean` and/or `dnf clean packages` (they take the package manager's lock); freed = size before minus after |
| `journal`           | System journal over 200 MB | `*.journal` files under `/var/log/journal`, minus 200 MiB                                                                      | `journalctl --vacuum-size=200M`; freed = size before minus after                                                    |
| `linux-crash-dumps` | Crash dumps                | All files in `/var/lib/systemd/coredump` and `/var/crash`                                                                      | Safe sweep                                                                                                          |
| `old-var-tmp`       | Old files in /var/tmp      | Files in `/var/tmp` not accessed, changed or modified for 30 days, outside `systemd-private-*`                                 | Safe sweep                                                                                                          |
| `unused-flatpaks`   | Unused Flatpak runtimes    | Unknown upfront (only offered when `flatpak` is installed)                                                                     | `flatpak uninstall --unused -y --noninteractive --system` (30 min limit); freed = free space after minus before     |
| `thumbnail-caches`  | Thumbnail caches           | All files in `~/.cache/thumbnails` of each home under `/home`, and of `/root`                                                  | Safe sweep                                                                                                          |

Commands run with full paths (`/usr/bin/apt-get`, `/usr/bin/dnf`, `/usr/bin/journalctl`, `/usr/bin/flatpak`, `%SystemRoot%\System32\Dism.exe`), a fixed argument list, a plain `PATH`, no shell, and a time limit (10 minutes unless stated).

### 11.3 The safe sweep

Every item that deletes files itself uses one sweep, the same for sizing and for cleaning, so the size shown is what the clean-up will try to delete.

- **Fixed roots, checked.** An item's roots are built on the machine from its id: a system folder (`/var/tmp`, `%SystemRoot%\Temp`), or a person's folder found under the profiles or homes folder. Every part of a root below the trusted system folder must be a real folder: a symbolic link, junction or other reparse point anywhere in it drops that root (counted as an error), so a person cannot point `~/.cache/thumbnails` or `AppData\Local\Temp` at a system folder.
- **Never through a link.** The sweep reads entries without following them. A link, junction or reparse point is never entered and never deleted; only regular files are deleted (no sockets, devices or pipes), plus folders that end up empty (never the root itself, nor the kept per-person folders).
- **Stays inside the root:** it never crosses onto another file system (Linux: another device; Windows: mount points are reparse points).
- **Deletes only what it listed, where it listed it.** Linux: the file is removed with `unlinkat` relative to its folder, opened with `O_NOFOLLOW | O_DIRECTORY`, whose real path (`/proc/self/fd`) must still be the folder the sweep listed, and the entry must still be the same file (device and inode). Windows: the file is opened with `FILE_FLAG_OPEN_REPARSE_POINT` and `DELETE` access, must not be a reparse point, and its final path (`GetFinalPathNameByHandleW`) must still be the listed path; it is then deleted through that handle. A folder swapped for a link between listing and deleting is refused, not followed.
- **Files in use or denied are skipped and counted** (Windows sharing violations; access denied on either system). A file that changed between listing and deleting is skipped.
- **Age rules** (Q14) use every time the system keeps: Linux access, modified and change times; Windows created, modified and accessed times. A file is old only when all of them are older than the rule.
- **Bytes freed** count a file's allocated size (Linux blocks; Windows length) once it is gone; a Linux file with other hard links frees nothing and counts 0 bytes.

### 11.4 Running it

- **Sizing** (`storage-cleanup-sizes`) runs on request in the files session, read-only, and answers each offered item with `{ kind: 'bytes', bytes, files }` or `{ kind: 'unknown' }`.
- **Starting** (`storage-cleanup-start {runId, items}`) checks the ids (offered on this machine, no repeats, at least one), refuses as `busy` when a clean-up runs or waits, then writes the request file `cleanup-wanted` (made create-new, so two starts cannot both win) and `<data>/storage/cleanup.json` (the run, every item waiting).
- **The cleaner** is `bmuster-agent storage-clean --data-dir <dir>`, started by the agent within about two seconds of the request: on an installed Linux agent as the transient service `bmuster-storage-clean.service` (outside the agent's sandbox, as root, no network, lowest priority, like the scan); otherwise as a child process. It takes `cleanup.lock` (released by the system if it dies), removes `cleanup-wanted`, and runs the items one by one, rewriting `cleanup.json` with each item's progress (every 2 seconds at most) and result.
- **Status** (`storage-cleanup-status`) reads `cleanup.json`: `none`, `running` (each item waiting, running with bytes freed so far, or done), `finished`, or `interrupted` (the cleaner died or the agent stopped it before the end: the lock is free and no request waits).
- **Each item's result:** bytes freed (counted, or measured from free space for commands without a size), files removed, files skipped, errors, and up to five error messages.
- **The check-in** carries the last run (`storage.cleanup`), so the server records the result even when nobody kept the tab open.

### 11.5 Server and routes

All `route.user`, thin, on the person's files session (`withChannel`: `view` and `files` through the access service on every request; a signed `files` ticket for the agent):

| Route                                               | Does                                                                         |
| :-------------------------------------------------- | :--------------------------------------------------------------------------- |
| `GET  /api/machines/[id]/storage/cleanup/items`     | `storage-cleanup-sizes`                                                      |
| `POST /api/machines/[id]/storage/cleanup` `{items}` | `storage-cleanup-start` with a new run id; records the run; audits the start |
| `GET  /api/machines/[id]/storage/cleanup`           | `storage-cleanup-status`; records a finished run once                        |

- The request body is `{ items: CleanupItemId[] }` (1 to 13 known ids, no repeats, nothing else), parsed with zod; anything else is 400 before the machine is asked.
- **`storage_cleanups`** (additive): `id` (the run id), `machine_id`, `user_id`, `items` (JSON ids), `requested_at`, `finished_at` (null while running), `outcome` (JSON results, null while running). A result is recorded once: the update touches only a row of **that machine** whose `finished_at` is still null, so a repeat (tab and check-in) or a run id from another machine changes nothing.
- The `storage-cleanup` audit entry names the person who started it, and is written in the same transaction as the result.

### 11.6 UI

A **Clean up** panel under the Storage tab's drive list, for people with `files` (the whole tab already needs it), while the machine is online:

- **Measure first:** a `Panel` with **Find what can be cleaned up**; then each offered item as a row: a tick box with the label, its size ("2.1 GB in 4,210 files", or "Frees an unknown amount, can take several minutes"), and the explanation underneath. Nothing is ticked at first. A line under the list totals the ticked items ("3 items, 4.6 GB selected", "plus an unknown amount" when such an item is ticked).
- **Clean up** (`danger` button; with nothing ticked it says to tick something) asks with `confirmAction`: "Clean up 3 items?", listing each item with its size, saying the files are deleted for good and files in use are skipped.
- **While it runs:** each item shows waiting, cleaning (with bytes freed so far) or done; the panel asks for the status every 3 seconds. The person can leave and come back: the panel opens on the running clean-up.
- **Results:** each item "Freed 1.9 GB · 4,100 files removed · 110 skipped", with errors under it; the total; and **Measure again**. An interrupted run says so.
- Phone first: one column, rows at least 40 px, tokens only (light and dark).

## 12. Phase 3: full-disk alerts

- **Nearly full** means a drive at **90 % used or more**. One rule (`lowDiskDrives` in `domain/storage`), fed by the latest check-in's per-drive summary (`machine_storage`), or by the inventory's disks for an agent before 0.4.17 that reports none.
- **Machines list:** a machine with a nearly full drive shows a warning tag "Low disk: C:\ 94 %" (every such drive in its text) on its card, and the same tag under the Disk figure in the table. It counts as **Needs attention**, and a new filter chip **Low disk** shows only those machines (the export takes the same filter).
- **Machine page:** the Overview shows a `Notice` (warning) "Disk nearly full" naming each drive, its percentage and free space, with a link to the Storage tab for people with `files`. The Storage tab shows the same notice above the drives (from the live summary).
- **Email:** a new notification event **Disk nearly full** (`disk-nearly-full`) in Settings → Notifications, carrying the machine, host name, drive, percent used and free space. It is raised from the check-in **once when a drive reaches 90 %**, and again only after that drive has dropped **below 85 %** and reached 90 % again (the drives alerted are kept in `machine_storage.low_disk_alerted`). A drive that disappears is forgotten.

## 13. Acceptance criteria (phases 2 and 3)

| #   | Criterion                                                                                                                                                                                                                                                                | Test                                                                                    |
| :-- | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :-------------------------------------------------------------------------------------- |
| S12 | The sweep sizes and deletes only regular files inside its root; never follows or deletes a link (a link to an outside folder leaves that folder intact); never enters another device; keeps the root and kept folders; removes folders it emptied.                       | agent `storage::cleanup::sweep::tests::s12_*`                                           |
| S13 | A root with a link anywhere below its trusted folder is dropped; a folder swapped for a link after listing is refused at delete time, and a file that changed since listing is skipped.                                                                                  | agent `storage::cleanup::sweep::tests::s13_*`, `storage::cleanup::safe::tests::s13_*`   |
| S14 | Age rules: only files older than the rule by every timestamp are sized and deleted (30 days in `/var/tmp`, 7 days in Windows temporary folders); `systemd-private-*` is skipped.                                                                                         | agent `storage::cleanup::sweep::tests::s14_*`, `storage::cleanup::items::tests::s14_*`  |
| S15 | Denied files are skipped and counted, never fatal; results count bytes freed, files removed, files skipped and errors.                                                                                                                                                   | agent `storage::cleanup::sweep::tests::s15_*`                                           |
| S16 | Each item builds the roots, rules and commands of 11.2 from the machine's folders (both systems, against temporary trees); an item that does not apply is not offered.                                                                                                   | agent `storage::cleanup::items::tests::s16_*`                                           |
| S17 | Requests carry ids only: unknown ids or paths do not parse (the server also refuses extra fields); a start with no items, repeats or an item not offered is `invalid`; a second start while one runs or waits is `busy`.                                                 | protocol `files` tests, agent `storage::cleanup::tests::s17_*`                          |
| S18 | The cleaner takes the lock, runs every item, writes progress and results; status reads running, finished and interrupted; the agent starts it when asked (`bmuster-storage-clean.service` on Linux).                                                                     | agent `storage::cleanup::tests::s18_*`, `storage::cleanup::launch::tests::s18_*`        |
| S19 | Every clean-up route checks `view` and `files` on the server (404, 403, 503 offline) and runs on the files session; the body is ids only; the start is recorded and audited; the result is recorded and audited once, from status or check-in, only for its own machine. | `storage-cleanup.test.ts`, `check-in.test.ts` (S19 block)                               |
| S20 | The Clean up panel: measure, sizes, tick, total, a confirmation naming the items, progress, results, interrupted; nothing is sent without confirming.                                                                                                                    | `storage-cleanup.svelte.test.ts`                                                        |
| S21 | A drive at 90 % or more is nearly full (from the check-in summary, else the inventory); the Machines list tags it, counts it as Needs attention and filters it with Low disk.                                                                                            | `domain/storage/storage.test.ts`, `machine-row.test.ts`, `machines-page.svelte.test.ts` |
| S22 | The Overview and the Storage tab show the Disk nearly full notice.                                                                                                                                                                                                       | `overview.svelte.test.ts`, `storage-tab.svelte.test.ts`                                 |
| S23 | `disk-nearly-full` is raised once on reaching 90 %, not again until the drive drops below 85 % and reaches 90 % again, and its email names the drive.                                                                                                                    | `machine-storage.test.ts`, `notifications.test.ts`                                      |
| S25 | The scheduler notices a Rescan now request within a tick (half a second) and starts the pass at once; never while one runs.                                                                                                                                              | agent `storage::schedule::tests::s25_*`                                                 |
| S26 | Rescan now while a pass runs asks nothing and answers `alreadyScanning: true`; an older agent's `{}` reads as asked; only an actual request is audited.                                                                                                                  | agent `storage::query::tests::s26_*`, `storage-cleanup.test.ts` (S26 block)             |
| S27 | The tab shows the pending state at once (button replaced), polls every 2 s until the scan shows, says plainly when it has not started after 60 s, and shows Already scanning with its percent.                                                                           | `storage-tab.svelte.test.ts` (S27)                                                      |
| S24 | Activity shows both clean-up entries in plain words.                                                                                                                                                                                                                     | `domain/storage/cleanup.test.ts`                                                        |

## 14. Schema changes (phases 2 and 3)

Additive, generated with `npm run db:generate`: the table `storage_cleanups` (11.5) and the column `machine_storage.low_disk_alerted` (text, a JSON list of mounts, default `[]`).

## 15. Security notes (phases 2 and 3)

- **A fixed list, ids only.** The protocol's item id is a closed enum; a request with an unknown id or a path does not parse, and the server refuses any other field. The agent builds every root, rule and command from the id and the machine's own folders. No path, pattern, argument or command crosses the wire.
- **Permission checked twice:** the server checks `view` and `files` on every clean-up request through the access service; the agent runs these ops only on a `files` session, opened with a signed, single-use ticket that names `files`.
- **Audited:** the start (who, which items) and the result (bytes freed, files removed and skipped, errors), written once per run.
- **Link safety and root-only scope** (11.3): no link is followed or deleted, every root is checked part by part, and each delete is bound to the folder or handle that was checked, so a person who controls their own temporary or cache folder cannot redirect a SYSTEM or root delete elsewhere.
- **Least surprise:** nothing runs on a schedule, only when a person with `files` asks; files in use are skipped; the commands are the system's own tools; the cleaner has no network on Linux.
- **The browser never decides what is deleted:** the sizes shown are the machine's own answer, and the confirmation names exactly the ids sent.

## 16. Not in this version

Change-tracking rescans (NTFS change journal, fanotify); resuming a cut-off pass; network drives; macOS; per-user (non-admin) views; scheduled clean-ups; folders a person picks to clean.

## 17. As built, phase 1 (2026-11-11)

| #   | Where                                                                                                                                                                                                                               | Tests                                                                         |
| :-- | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :---------------------------------------------------------------------------- |
| S1  | Agent `storage/walk.rs`: an explicit stack (no recursion), `symlink_metadata` entries, Linux blocks × 512 and `(dev, inode)` once for hard links, Windows length with cloud placeholders at 0 and reparse points not walked.        | `storage::walk::tests::s1_*`                                                  |
| S2  | `walk.rs`: a folder on another device is not queued; `/proc`, `/sys`, `/dev`, `/run` never are. Drives from `files/roots.rs` `scan_targets` (Linux: local mounts without network file systems or `/media`; Windows: `DRIVE_FIXED`). | `storage::walk::tests::s2_*`, `files::roots::tests::the_storage_scan_walks_*` |
| S3  | `walk.rs` `Folder::adopt` and `refold`, threshold 1 MiB × 4 above 100,000 kept folders; a min-heap of the 1,000 largest files.                                                                                                      | `storage::walk::tests::s3_*`                                                  |
| S4  | Agent `storage/store.rs` (magic `BMSTOR\0\1`, SHA-256 trailer, depth and count limits), saved with `identity::write_private` (owner-only `<key>.tmp`, `fsync`, rename).                                                             | `storage::store::tests::s4_*`                                                 |
| S5  | Agent `storage/query.rs`, answered by the files session's request code (`sessions/files.rs`; on Linux in the files helper, which now takes `--data-dir`). Protocol: `FilesOp::Storage*`, `protocol/src/storage.rs`.                 | `storage::query::tests::s5_*`, protocol `files` and `storage` tests           |
| S6  | Agent `storage/schedule.rs` `due`: 10 minutes after start, a drive older than 24 h, or `rescan`; a pass that did not finish waits an hour before the next try.                                                                      | `storage::schedule::tests::s6_*`                                              |
| S7  | Agent `storage/pace.rs`: `setpriority` 19 and `ioprio_set` idle (Linux), `PROCESS_MODE_BACKGROUND_BEGIN` (Windows); 50 ms slices; battery and CPU above 70 % checked every 30 s.                                                    | `storage::pace::tests::s7_*`                                                  |
| S8  | Check-in `storage` (agent `worker.rs`, `storage::report`); server `checkInRequestSchema.storage`, table `machine_storage` (migration 0017), `services/machines/machine-storage.ts`.                                                 | `check-in.test.ts` (S8 block), protocol `storage` tests                       |
| S9  | `services/sessions/storage.ts` on `withChannel` (Files' per-request check and ticket); routes `api/machines/[id]/storage/{summary,folder,largest,rescan}`; audit kind `storage-rescan-requested`.                                   | `storage.test.ts`                                                             |
| S10 | `(console)/machines/[id]/storage/`: `storage-browser.svelte`, `drive-list.svelte`, `folder-list.svelte`, `largest-list.svelte`, Files' `BreadcrumbBar`; `+page.server.ts` gives the last report (only with `files`).                | `storage-tab.svelte.test.ts`, `domain/storage/storage.test.ts`                |
| S11 | `exec/unit.rs` `Kind::Storage`: `bmuster-storage-scan.service` with `PrivateNetwork=yes`, `UMask=0077`, `Nice=19`, `IOSchedulingClass=idle`; the sweep includes `bmuster-storage-*`.                                                | `exec::unit::tests::s11_*`                                                    |

**Different from the spec or decided while building**

- **A killed pass** leaves `state.json` saying it runs; the agent reads a pass as running only while it holds `scan.lock` (`storage::pass_running`), so the tab never shows a scan stuck at some percent.
- **Retry:** a pass that ended without finishing every drive (killed, or a drive that could not be saved) is tried again an hour after it started, not every minute.
- **Open in Files** is on the folder's summary panel (one link per folder), not on each row: a row is already a button. It sets the Files tab's remembered folder, so Files opens there.
- **The temporary file** is `<key>.tmp` (`write_private` swaps the extension).
- **Hard links on Linux** are remembered by `(device, inode)` for the whole pass; a disk of hard-link backups (rsnapshot, Timeshift) costs about 16 bytes per linked file in memory while it is scanned.
- **Dead code:** `DESKTOP_QUALITIES` (from main, used only inside its module) lost its `export` so `knip` passes.

**Checked by hand:** `bmuster-agent storage-scan --data-dir <scratch> --asked` as the developer: it took the lock, wrote progress to `state.json` every 10 s (61 GB counted in 25 s at the asked pace, warm cache) and was stopped by a timeout.

**Not tested here:** any Windows code at run time or compile time (this machine cannot build the Windows target: `ring` needs MinGW): `scan_targets` (`GetDriveTypeW`), `walk.rs` `sized`/`is_reparse_point` (attributes), `pace.rs` `lower_priority` (`SetPriorityClass`) and `power_source`. Also not run: an installed Linux agent starting the scan unit as root, a full pass to the end on a real disk, and the tab in a real browser session against a live agent (the tab is covered by browser tests at 390 px with mocked replies).

## 18. As built, phases 2 and 3 (2026-11-11)

| #   | Where                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Tests                                                                                           |
| :-- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :---------------------------------------------------------------------------------------------- |
| S12 | Agent `storage/cleanup/sweep.rs`: an explicit stack, `DirEntry::metadata` (never follows), regular files only, links and reparse points neither entered nor deleted, the root's device only, emptied folders removed on the way back up.                                                                                                                                                                                                                        | `storage::cleanup::sweep::tests::s12_*`                                                         |
| S13 | `sweep.rs` `checked_root` (each part below the trusted folder must be a real folder); `storage/cleanup/safe.rs` `remove`: Linux `open(O_NOFOLLOW \| O_DIRECTORY)`, `/proc/self/fd` real path, `fstatat` device, inode and kind, `unlinkat`; Windows `CreateFileW(FILE_FLAG_OPEN_REPARSE_POINT, DELETE)`, attribute tag, `GetFinalPathNameByHandleW`, `FileDispositionInfoEx` (POSIX semantics, ignore read-only; plain `FileDispositionInfo` on older Windows). | `storage::cleanup::safe::tests::s13_*`, `sweep::tests::s13_*`, `items::tests::s13_*`            |
| S14 | `sweep.rs` `Rule::min_age` and `old_enough` (access, modified and change times on Linux; created, modified and accessed on Windows); `items.rs` `VAR_TMP_AGE` 30 days with `systemd-private-` skipped, `WINDOWS_TEMP_AGE` 7 days.                                                                                                                                                                                                                               | `sweep::tests::s14_*`, `items::tests::s14_*`                                                    |
| S15 | `safe.rs` `Removal` (in use, denied, changed count as skipped; other failures are errors, five messages kept); an unreadable folder is skipped.                                                                                                                                                                                                                                                                                                                 | `sweep::tests::s15_*`                                                                           |
| S16 | `storage/cleanup/items.rs`: `Machine::{Windows, Linux}` folders, `plan` per id, tools with full paths and limits (`run_tool`: no shell, plain `PATH` on Linux, stderr's last line in the error, killed at the limit).                                                                                                                                                                                                                                           | `items::tests::s16_*`                                                                           |
| S17 | Protocol `cleanup.rs` (`CleanupItem` closed enum, `valid_run_id`), `FilesOp::StorageCleanup{Sizes,Start,Status}`; agent `cleanup::start` (ids offered here, no repeats, `cleanup-wanted` create-new).                                                                                                                                                                                                                                                           | protocol `cleanup::tests::s17_*`, `files::tests::s17_*`, agent `storage::cleanup::tests::s17_*` |
| S18 | `cleanup::run` (`bmuster-agent storage-clean`), `cleanup::status`; `cleanup/launch.rs` `Launcher`, ticked by the storage scheduler every 500 ms; `schedule.rs` `launch` shared by the scan and the clean-up (`bmuster-storage-clean.service`).                                                                                                                                                                                                                  | `storage::cleanup::tests::s18_*`, `cleanup::launch::tests::s18_*`, `exec::unit::tests::s18_*`   |
| S19 | `services/sessions/storage-cleanup.ts`, `services/machines/storage-cleanups.ts`, routes `api/machines/[id]/storage/cleanup` (GET, POST) and `cleanup/items` (GET), table `storage_cleanups` (migration 0018); the check-in records `storage.cleanup`.                                                                                                                                                                                                           | `storage-cleanup.test.ts`, `check-in.test.ts` (S19)                                             |
| S20 | `(console)/machines/[id]/storage/cleanup-panel.svelte` under the drive list; `domain/storage/cleanup.ts` words.                                                                                                                                                                                                                                                                                                                                                 | `storage-cleanup.svelte.test.ts`, `domain/storage/cleanup.test.ts`                              |
| S21 | `domain/storage/storage.ts` `lowDiskDrives`; `Machine.lowDisk` (`machine-views.ts` `toLowDisk`: `machine_storage`, else inventory disks); `machine-row.ts` filter `low-disk`, Needs attention; `(console)/low-disk-tag.svelte` on cards and in the table's Status cell.                                                                                                                                                                                         | `domain/storage/storage.test.ts`, `machine-row.test.ts`, `machines-page.svelte.test.ts`         |
| S22 | `(console)/machines/[id]/low-disk-notice.svelte` on the Overview (link to Storage with `files`) and the Storage tab (from the live summary).                                                                                                                                                                                                                                                                                                                    | `overview.svelte.test.ts`, `storage-tab.svelte.test.ts`                                         |
| S23 | `lowDiskAlerts`; `machine-storage.ts` `storeCheckInStorage` keeps `low_disk_alerted` and raises `disk-nearly-full`; `notify.ts` renders the email (link to the Storage tab).                                                                                                                                                                                                                                                                                    | `domain/storage/storage.test.ts`, `machine-storage.test.ts`, `notifications.test.ts`            |
| S24 | Audit kinds `storage-cleanup-started` ("Started a disk clean-up") and `storage-cleanup` ("Cleaned up disk space"), detail in words (items, freed, files removed, files skipped, errors, result).                                                                                                                                                                                                                                                                | `domain/storage/cleanup.test.ts`                                                                |
| S25 | `schedule.rs` `look_now` and `TICK` (500 ms).                                                                                                                                                                                                                                                                                                                                                                                                                   | `storage::schedule::tests::s25_*`                                                               |
| S26 | `query.rs` `rescan`, `FilesResult::StorageRescan`; server `rescanReplySchema` (defaults `alreadyScanning` to false).                                                                                                                                                                                                                                                                                                                                            | `storage::query::tests::s26_*`, `storage-cleanup.test.ts` (S26)                                 |
| S27 | `storage-browser.svelte` `Rescan` state, `followRescan` every 2 s, 60 s limit.                                                                                                                                                                                                                                                                                                                                                                                  | `storage-tab.svelte.test.ts` (S27)                                                              |

**Different from the spec or decided while building**

- **Rescan now while pending:** the shared `Button` has no disabled state (adding one would change 128 callers), so while the request is pending the button is replaced by the "Asking <machine> to scan…" status; it comes back when the scan shows or the wait ends.
- **Extra fields** in a start request are refused by the server (`z.strictObject`); the agent's protocol ignores unknown fields as every files op does, and builds everything from the ids.
- **Windows temporary folders** keep files newer than 7 days (Windows' own Disk Clean-up rule), which the request did not state; nothing else has an age rule besides `/var/tmp`.
- **Windows Update cache:** files in use are skipped; `wuauserv` is not stopped (Q15).
- **Linked roots** (a person's `.cache/thumbnails` or `AppData\Local\Temp` that is a link) are reported as an error on that item and left alone; profile junctions such as `All Users` are not profiles and are skipped silently.
- **A clean-up's progress** is written every 2 seconds at most; the tab asks every 3 seconds.
- **The cleaner on Windows** runs at normal priority (DISM and the sweep finish sooner); on Linux the unit runs it at nice 19 and idle disk priority, as the scan.
- **Interrupted runs** are recorded with `finished_at` = when the server learned of it.

**Checked by hand:** nothing on a real machine: the cleaner, the units and the tab were run only in tests (temporary trees, fake tools, a fake agent and mocked replies at 390 px).

**Not tested here:** any Windows code at run time. It compiles and passes `cargo clippy -D warnings` for `x86_64-pc-windows-gnu` (zig as the C compiler): `safe.rs` `windows::remove` (`CreateFileW`, `GetFileInformationByHandleEx`, `GetFinalPathNameByHandleW`, `SetFileInformationByHandle`), `Machine::this` on Windows (`SystemRoot`, `SystemDrive`), the Windows item roots on real folders (tested only as plain folders on Linux), DISM through `run_tool`, the cleaner as a child process of the Windows service, `is_reparse_point` in the sweep. Not run on Linux either: `apt-get clean`, `dnf clean packages`, `journalctl --vacuum-size`, `flatpak uninstall --unused` (stand-in scripts only), and `bmuster-storage-clean.service` under systemd.

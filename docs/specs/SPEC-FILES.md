# SPEC-FILES: The Files tab (browse, download, upload)

**Status:** `APPROVED` · decisions approved 2026-11-07 (research plan, Part 2, phases 5–6) · Reuses the session ticket, sockets, relay and agent pump of SPEC-SESSIONS.

## 1. Problem

The Files tab is a prototype with made-up rows. Helpdesk work needs the real thing: look around a machine's disks, fetch a log file, drop an installer onto it, tidy up a folder, all from a phone if need be. Transfers must survive a dropped connection, because phones lose theirs.

## 2. Acceptance criteria

| #   | Criterion                                                                                                                                                                                                                                                                                                                                   | Test                                                             |
| :-- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | :--------------------------------------------------------------- |
| F1  | Who may: admins always; members with the `files` permission (SPEC-ACCESS). The server checks it when it issues the ticket **and on every files request**; the ticket's purpose is `files`, which needs `files`; the agent runs file actions only on a `files` ticket.                                                                       | `files.test.ts`, agent `ticket` tests                            |
| F2  | **Roots:** Windows lists drives with type, size and free space; Linux and macOS list `/` and the real mount points, with size and free space.                                                                                                                                                                                               | agent `files::roots` tests, `files-tab.svelte.test.ts`           |
| F3  | **Listing** shows name, kind (file, folder, link, other), size, modified time and hidden flag; links show as links and are never followed when walking. At most 5,000 entries, with "Showing the first 5,000".                                                                                                                              | agent `files::ops` tests, `files-tab.svelte.test.ts`             |
| F4  | **Path safety:** paths are absolute; names are one part (no `/`, `\`, `..`, NUL or `:`); Windows device paths (`\\.\`, `\\?\`), UNC paths and reserved names (CON, NUL, COM1…) are refused.                                                                                                                                                 | agent `files::paths` tests, `files-schemas.test.ts`              |
| F5  | **Download:** `GET …/files/download?path=` streams through the server and is never stored there. It sends Content-Length, Content-Disposition, Accept-Ranges, Last-Modified and an ETag, and honours `Range` (and `If-Range`), so the browser's own download manager resumes. The server hashes the bytes it sends (SHA-256) for the audit. | `range.test.ts`, `files.test.ts`, agent `read` tests, end to end |
| F6  | **Upload:** begin (checks free space and the size cap, returns how much a `.bmuster-part` file already holds), 8 MB `PUT` chunks at an offset, end (checks size and SHA-256, renames into place), cancel (removes the part file). The cap is a server setting, 10 GB by default.                                                            | agent `write` tests, `files.test.ts`, end to end                 |
| F7  | **Folder actions:** new folder, rename, delete many at once. Folders are deleted recursively only after the person types a confirmation; a link is deleted as a link and its target is left alone.                                                                                                                                          | agent `delete` tests, `files-tab.svelte.test.ts`, end to end     |
| F8  | **Audit:** `file-downloaded` and `file-uploaded` (path, size, SHA-256), `files-deleted` (paths and count), `file-renamed`, `folder-created`; the files session's own `session-opened` and `session-ended`. Listing is not audited.                                                                                                          | `files.test.ts`                                                  |
| F9  | **UI (phone first):** breadcrumbs that scroll sideways; drive cards with free-space bars; rows with a tick box, icon, name, size and date; a sheet for one file (Download, Rename, Delete); a sticky bar once anything is ticked ("N selected · Download · Delete · Clear") and Select all; sort by name, date or size; Show hidden.        | `files-tab.svelte.test.ts`, screenshots                          |
| F10 | **Upload tray:** several files at once, progress per file, cancel per file, and resume after a dropped connection.                                                                                                                                                                                                                          | `upload-queue.test.ts`, end to end                               |
| F11 | Offline and no-permission states use the shared `EmptyState`.                                                                                                                                                                                                                                                                               | `files-tab.svelte.test.ts`, `no-permission.svelte.test.ts`       |
| F12 | "In use: files by <name>" shows while a person's files session is open.                                                                                                                                                                                                                                                                     | `relay.test.ts`                                                  |

## 3. Design

**Everything runs as the agent** (root or SYSTEM), as MeshCentral does; the `files` permission is the gate. Running as the signed-in user comes later.

**One files session per person per machine, owned by the server.** The browser only makes HTTP requests. The first files request opens a session: the server signs a ticket with purpose `{ "kind": "files" }` and sends `session-open`; the agent opens `/agent/v1/sessions/[id]` as for a terminal. The server, not a browser, is the other end of that socket: the relay's "local end". Requests from any number of browser calls are multiplexed on it by request id. The session ends after 5 minutes with no request running ("Not used for 5 minutes"), so a download link keeps working across a page reload, and the browser's download manager can resume after the tab has closed.

**Messages on the agent's files socket.**

- Server to agent, text: `{ "id": 7, "op": "list", "path": "/srv" }`. Ops: `roots`, `list {path}`, `stat {path}`, `mkdir {dir,name}`, `rename {dir,from,to}`, `delete {dir,names,recursive}`, `read {path,offset,length}`, `write-begin {dir,name,size,replace}`, `write-chunk {dir,name,offset}` (followed by one binary frame with the data), `write-end {dir,name,size,sha256}`, `write-cancel {dir,name}`; and, for a running read, `ack {bytes}` and `cancel`.
- Agent to server, text: `{ "id": 7, "type": "done", "result": {…} }` or `{ "id": 7, "type": "error", "code": "not-found", "message": "…" }`. Codes: `invalid`, `not-found`, `exists`, `not-empty`, `denied`, `no-space`, `offset`, `mismatch`, `busy`, `io`.
- Binary frames, both ways: a 4-byte big-endian request id, then the bytes (a read's data, or a chunk's).
- **Flow control for reads:** the agent sends at most 4 MB ahead of the server's `ack`s, per read, so one slow download never stalls the socket for the others.

**HTTP routes** (all `route.user`, thin; each checks `view` and `files` through the access service):

| Route                                                                  | Does                                    |
| :--------------------------------------------------------------------- | :-------------------------------------- |
| `GET  /api/machines/[id]/files/roots`                                  | drives or mounts                        |
| `GET  /api/machines/[id]/files/list?path=`                             | one folder                              |
| `POST /api/machines/[id]/files/folder` `{dir,name}`                    | new folder (audited)                    |
| `POST /api/machines/[id]/files/rename` `{dir,from,to}`                 | rename (audited)                        |
| `POST /api/machines/[id]/files/delete` `{dir,names,recursive}`         | delete (audited)                        |
| `GET  /api/machines/[id]/files/download?path=`                         | the file, with Range                    |
| `POST /api/machines/[id]/files/upload/begin` `{dir,name,size,replace}` | `{partSize}`                            |
| `PUT  /api/machines/[id]/files/upload?dir=&name=&offset=`              | one chunk (at most 8 MB) → `{partSize}` |
| `POST /api/machines/[id]/files/upload/end` `{dir,name,size,sha256}`    | renames into place (audited)            |
| `POST /api/machines/[id]/files/upload/cancel` `{dir,name}`             | removes the part file                   |

**Uploads.** The browser hashes the file (SHA-256, streamed with `@noble/hashes`) while it sends it; on a resume it first hashes the part already sent. The agent hashes the finished part file and refuses to rename it when the two differ. `BODY_SIZE_LIMIT` is 16M in the image and the server launcher, above the 8 MB chunk.

**Path safety** is about correctness, not a sandbox (the agent is root): absolute paths only; no `..` parts; names are one part; Windows device and verbatim paths, UNC paths, reserved names and `:` (alternate data streams) are refused; deleting and walking never follow links.

## 4. Security notes

- Security work (AGENTS.md: the agent channel). Nothing is weakened: the ticket's signature, machine, time window, single use and the permission its purpose needs are checked exactly as for terminals, and the server re-checks `files` on every request, so taking the permission away stops the next request at once.
- The download URL carries only the machine id and path; it works only with the person's own console cookie.
- Upload and download content is never stored on the server and never logged; the audit has path, size and hash.

## 5. Not in this version

Zip download of a folder or a selection (later, streamed); running as the signed-in user; copy and move; UNC paths; share links for files.

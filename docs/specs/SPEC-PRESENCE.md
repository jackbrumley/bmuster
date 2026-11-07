# SPEC-PRESENCE: Fast, live online and offline

**Status:** `IMPLEMENTED` (P1–P8 built; version bump and changelog left for the release step) · **Date:** 2026-11-07 · Changes SPEC-ENROLMENT 8 (online rule); adds two events to SPEC-EMAIL E6.

## 1. Problem

When a machine disconnected, the console kept showing it Online for up to 15 minutes: a machine was online while its live socket was open **or** while its last check-in was within 3 intervals (3 × 300 s). The Machines list only changed on navigation. Nobody heard when a machine went offline or came back.

Every current agent holds a live socket, pinged every 30 s (a socket that misses a pong is dropped), so the socket is the fast, honest signal.

## 2. Acceptance criteria

| #   | Criterion                                                                                                                                                                                                                                                                                                                                                     | Test                                                        |
| :-- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | :---------------------------------------------------------- |
| P1  | A machine whose agent has ever held a live socket is online while the socket is open, whatever its last check-in.                                                                                                                                                                                                                                             | `presence.test.ts`                                          |
| P2  | When the socket closes, the machine stays online for a **grace period of 60 s** (`PRESENCE_GRACE_MS`); if the socket is still gone then, it shows **Offline · since** the moment the socket closed.                                                                                                                                                           | `presence.test.ts`                                          |
| P3  | A reconnect within the grace (a blip) changes nothing anyone sees and records nothing.                                                                                                                                                                                                                                                                        | `presence.test.ts`                                          |
| P4  | After a server restart nobody is connected yet. A machine that was online when the server stopped stays online until its last contact (or the restart, if later) plus **twice the grace** (agents wait up to 60 s between reconnect attempts), then goes offline since its last contact. A machine that was offline stays offline since then.                 | `presence.test.ts`                                          |
| P5  | The Machines list (Cards and Table) and the machine header update status without a reload, over server-sent events from `GET /api/machines/events`. Scroll position and the batches drawn stay put. Without the feed (no EventSource, or the stream refused) the page reloads its data every 15 s while visible; a dropped feed that comes back reloads once. | `machine-feed.test.ts`, `machines-page.svelte.test.ts`, E2E |
| P6  | Going offline (when the grace runs out) and coming back online (when an offline machine reconnects) are recorded in Activity ("mint went offline", "mint came back online") and raised as the notification events **Machine went offline** and **Machine came back online**. Nothing is emailed unless a rule picks them.                                     | `presence.test.ts`, `local-page-activity.test.ts`           |
| P7  | An agent that has never opened a live socket (a proxy that blocks WebSockets) keeps the check-in rule: online within 3 check-in intervals, then offline since its last check-in. It records no Activity entries.                                                                                                                                              | `presence.test.ts`, `machine-views.test.ts`                 |
| P8  | The feed respects access: each event is checked when it happens. A member hears only about machines they can see now; a feed whose session has ended (signed out, expired, disabled) stops.                                                                                                                                                                   | `machine-feed.test.ts`                                      |

## 3. Schema (additive)

| Table      | Columns                                                                                                                                                                                                      |
| :--------- | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `machines` | + `socket_connected_at` (nullable: when the live socket last opened; null = never used it), + `socket_offline_since` (nullable: set when the grace ran out, to when the socket closed; cleared on reconnect) |

Who is connected, and the grace timers, live in memory (`services/agents/presence.ts`, on `globalThis` like the live-agent registry). The two columns are what a restart needs.

## 4. Routes

| Method | Path                   | Guard                                                       |
| :----- | :--------------------- | :---------------------------------------------------------- |
| GET    | `/api/machines/events` | user; every event re-checks the session and `canSeeMachine` |

`text/event-stream`: `retry: 5000` first, then `event: status` with `{ machineId, status, atIso }` (`status` is `{ kind: 'online' }` or `{ kind: 'offline', sinceIso }`), and a comment every 25 s so proxies keep it open. `X-Accel-Buffering: no` for nginx.

## 5. Decisions

1. **Server-sent events, not the WebSocket infrastructure.** The feed is one-way. An EventSource is an ordinary GET: it goes through the session hook and a route guard with the console cookie, like every other console request, where a browser WebSocket needs a short-lived ticket and authenticates itself outside the hooks. EventSource also reconnects by itself. The browser side lives in the one API client (`apiEvents`), parsed with a zod contract.
2. **Overlay, not reload.** A pushed status is laid over the loaded list when it is newer than the page's data (`atIso` against the load's `now`); a later reload wins. 500 machines going offline in the evening cost 500 small events per open console, not 500 reloads.
3. **Grace 60 s; restart grace 120 s.** Long enough for an agent's quick reconnect (1 s back-off at first), short enough to be honest. After a restart agents may be on their 60 s back-off, so the restart grace is twice the normal one.
4. **Offline since the socket closed**, not since the grace ran out; the Activity entry carries that time too.
5. **A socket agent stays judged by its socket.** If one later loses the socket but still checks in over HTTPS, it shows offline: sessions need the socket.

## 6. As built (2026-11-07)

- `services/agents/presence.ts`: `socketOpened`, `socketClosed`, `restorePresence` (from `hooks.server.ts` `init`), `presenceOf` (used by `machine-views.ts` for every machine), `onStatusChange` (the feed). `agent-socket.ts` calls it; a connection replaced by a newer one from the same machine does not count as a close.
- `services/machines/machine-feed.ts` and `routes/api/machines/events/+server.ts`; browser side `runes/live-statuses.svelte.ts` and `apiEvents` in `utils/api-client.ts`.
- `MachineStatus` offline carries `sinceIso` (was `lastSeenIso`); the table's Last seen column, its sort and Overview use it.
- Audit kinds `machine-offline` (warning tint, Wi-Fi off icon) and `machine-online` (Wi-Fi icon), actor System; worded by `activitySentence`.
- Notification events `machine-offline` and `machine-online` (detail: machine name, host name, offline since), in the rule editor's event list from the catalogue.
- Machines a socket-less agent moves between online and offline by the check-in rule are not pushed; the page shows them on its next load.
- E2E: a scratch built server and the debug agent on a spare port; killing the agent shows Offline in the list and the header within about 60 s, restarting it shows Online again, with no reload.

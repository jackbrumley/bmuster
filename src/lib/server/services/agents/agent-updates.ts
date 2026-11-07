import { createHash } from 'node:crypto';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import {
	EARLY_UPDATES_GROUP,
	NEW_UPDATE_RECORD,
	advanceStage,
	firstStage,
	machineUpdateState,
	shouldOffer,
	type MachineUpdateState,
	type RolloutStage,
	type UpdateEvent,
	type UpdateRecord
} from '#lib/domain/machines/agent-updates.ts';
import { compareAgentVersions, isOlderAgent } from '#lib/domain/machines/agent-version.ts';
import type { UpdateOffer, UpdateReport } from '#lib/schemas/agents/agent-protocol.ts';
import {
	agentRollouts,
	machineGroupMembers,
	machineGroups,
	machineUpdates,
	machines
} from '../../database/schema.ts';
import type { AppDatabase, Queryable } from '../../database/connection.ts';
import { recordAudit } from '../audit/audit.ts';
import { getSetting } from '../settings/settings.ts';
import type { ReleaseLookup, SignedRelease } from './releases.ts';

/**
 * Agent updates on the server (SPEC-AGENT-UPDATES). The server never signs or
 * changes a build: it offers the newest signed one in check-in replies,
 * following the policy, the staged roll-out, pins and Update now, and records
 * what agents report (updated, rolled back, refused). A failure pauses the
 * roll-out of that version. Every pin, request, pause, update, rollback and
 * refusal is audited.
 */

type UpdateRow = typeof machineUpdates.$inferSelect;
type RolloutRow = typeof agentRollouts.$inferSelect;

function toEvent(row: UpdateRow): UpdateEvent {
	const atIso = (row.lastEventAt ?? new Date(0)).toISOString();
	switch (row.lastEventKind) {
		case 'none':
			return { kind: 'none' };
		case 'updated':
			return { kind: 'updated', version: row.lastEventVersion, atIso };
		case 'rolled-back':
		case 'refused':
			return {
				kind: row.lastEventKind,
				version: row.lastEventVersion,
				reason: row.lastEventReason,
				atIso
			};
	}
}

function toRecord(row: UpdateRow | undefined): UpdateRecord {
	if (row === undefined) {
		return NEW_UPDATE_RECORD;
	}
	return {
		launcher: row.launcher,
		pinned: row.pinnedAt !== null,
		requested:
			row.requestedVersion === null
				? { kind: 'none' }
				: { kind: 'version', version: row.requestedVersion },
		offered:
			row.offeredVersion === null || row.offeredAt === null
				? { kind: 'none' }
				: { kind: 'version', version: row.offeredVersion, atMs: row.offeredAt.getTime() },
		lastEvent: toEvent(row)
	};
}

function updateRow(database: Queryable, machineId: string): UpdateRow | undefined {
	return database
		.select()
		.from(machineUpdates)
		.where(eq(machineUpdates.machineId, machineId))
		.get();
}

/** Creates the machine's row if it has none, then applies `set`. */
function upsert(
	database: Queryable,
	machineId: string,
	set: Partial<Omit<UpdateRow, 'machineId'>>
): void {
	database
		.insert(machineUpdates)
		.values({ machineId, launcher: false, ...set })
		.onConflictDoUpdate({ target: machineUpdates.machineId, set })
		.run();
}

/** Machines in the Early updates group (by name, any case). */
function earlyMachineIds(database: Queryable): Set<string> {
	const rows = database
		.select({ machineId: machineGroupMembers.machineId })
		.from(machineGroupMembers)
		.innerJoin(machineGroups, eq(machineGroups.id, machineGroupMembers.machineGroupId))
		.innerJoin(machines, eq(machines.id, machineGroupMembers.machineId))
		.where(
			and(
				sql`lower(${machineGroups.name}) = ${EARLY_UPDATES_GROUP.toLowerCase()}`,
				isNull(machines.removedAt)
			)
		)
		.all();
	return new Set(rows.map((row) => row.machineId));
}

/** A stable 0–99 per machine and version: the 10% stage is the same machines every time. */
function bucketOf(machineId: string, version: string): number {
	return createHash('sha256').update(`${machineId}\n${version}`).digest().readUInt16BE(0) % 100;
}

/** The roll-out of `version`, started now if it is new, moved on by the hours since. */
function currentRollout(database: Queryable, version: string, now: number): RolloutRow {
	const existing = database
		.select()
		.from(agentRollouts)
		.where(eq(agentRollouts.version, version))
		.get();
	if (existing === undefined) {
		const created = {
			version,
			startedAt: new Date(now),
			stage: firstStage(earlyMachineIds(database).size),
			stageStartedAt: new Date(now),
			pausedAt: null,
			pausedReason: null,
			pausedBy: null
		};
		database.insert(agentRollouts).values(created).run();
		return created;
	}
	if (existing.pausedAt !== null) {
		return existing;
	}
	const advanced = advanceStage(
		{ stage: existing.stage, stageStartedAt: existing.stageStartedAt.getTime() },
		now
	);
	if (advanced.stage === existing.stage) {
		return existing;
	}
	const moved = { stage: advanced.stage, stageStartedAt: new Date(advanced.stageStartedAt) };
	database.update(agentRollouts).set(moved).where(eq(agentRollouts.version, version)).run();
	return { ...existing, ...moved };
}

function pause(
	database: Queryable,
	version: string,
	reason: string,
	by: { kind: 'system' } | { kind: 'user'; userId: string },
	machine: { id: string; name: string } | null,
	now: number
): boolean {
	const rollout = currentRollout(database, version, now);
	if (rollout.pausedAt !== null) {
		return false;
	}
	database
		.update(agentRollouts)
		.set({
			pausedAt: new Date(now),
			pausedReason: reason,
			pausedBy: by.kind === 'user' ? by.userId : null
		})
		.where(eq(agentRollouts.version, version))
		.run();
	recordAudit(
		database,
		{
			actor: by,
			kind: 'agent-rollout-paused',
			target: `Version ${version}`,
			machineId: machine?.id ?? null,
			detail: { reason }
		},
		now
	);
	return true;
}

/** Records the agent's last update event once (its own time tells a new one from a repeat). */
function recordEvent(
	database: Queryable,
	machine: { id: string; name: string },
	row: UpdateRow | undefined,
	event: Extract<UpdateReport, { kind: 'launcher' }>['last'],
	now: number
): void {
	if (event.kind === 'none' || row?.lastEventAt?.getTime() === event.atMs) {
		return;
	}
	const at = new Date(event.atMs);
	switch (event.kind) {
		case 'updated':
			upsert(database, machine.id, {
				lastEventKind: 'updated',
				lastEventVersion: event.to,
				lastEventReason: '',
				lastEventAt: at,
				requestedVersion: null,
				requestedAt: null
			});
			recordAudit(
				database,
				{
					actor: { kind: 'system' },
					kind: 'agent-updated',
					target: machine.name,
					machineId: machine.id,
					detail: { from: event.from, to: event.to }
				},
				now
			);
			return;
		case 'rolled-back':
		case 'refused':
			upsert(database, machine.id, {
				lastEventKind: event.kind,
				lastEventVersion: event.version,
				lastEventReason: event.reason,
				lastEventAt: at,
				requestedVersion: null,
				requestedAt: null
			});
			recordAudit(
				database,
				{
					actor: { kind: 'system' },
					kind: event.kind === 'rolled-back' ? 'agent-update-rolled-back' : 'agent-update-refused',
					target: machine.name,
					machineId: machine.id,
					detail: { version: event.version, reason: event.reason }
				},
				now
			);
			pause(
				database,
				event.version,
				`${machine.name} ${event.kind === 'rolled-back' ? 'rolled back' : 'refused'} ${event.version}: ${event.reason}`,
				{ kind: 'system' },
				machine,
				now
			);
			return;
	}
}

/**
 * The update part of a check-in: records what the agent reported and decides
 * whether this reply offers it the newest signed build for its target.
 */
export function checkInUpdate(
	database: AppDatabase,
	machineId: string,
	agentVersion: string,
	report: UpdateReport,
	releases: ReleaseLookup,
	now: number
): UpdateOffer {
	return database.transaction((tx) => {
		const machine = tx
			.select({ id: machines.id, name: machines.name, target: machines.target })
			.from(machines)
			.where(eq(machines.id, machineId))
			.get();
		if (machine === undefined) {
			return { kind: 'none' };
		}
		const before = updateRow(tx, machineId);
		upsert(tx, machineId, { launcher: report.kind === 'launcher' });
		if (report.kind === 'launcher') {
			recordEvent(tx, machine, before, report.last, now);
		}
		const row = updateRow(tx, machineId);
		const record = toRecord(row);
		if (
			record.requested.kind === 'version' &&
			!isOlderAgent(agentVersion, record.requested.version)
		) {
			upsert(tx, machineId, { requestedVersion: null, requestedAt: null });
		}
		const latest = releases(machine.target);
		if (latest === undefined || !record.launcher) {
			return { kind: 'none' };
		}
		const rollout = currentRollout(tx, latest.version, now);
		const offer = shouldOffer({
			agentVersion,
			latest: latest.version,
			record,
			policy: getSetting(tx, 'agentUpdatePolicy'),
			rollout: { paused: rollout.pausedAt !== null, stage: rollout.stage },
			inEarlyGroup: earlyMachineIds(tx).has(machineId),
			bucket: bucketOf(machineId, latest.version)
		});
		if (!offer) {
			return { kind: 'none' };
		}
		if (row?.offeredVersion !== latest.version) {
			upsert(tx, machineId, { offeredVersion: latest.version, offeredAt: new Date(now) });
		}
		return {
			kind: 'offer',
			version: latest.version,
			size: latest.size,
			sha256: latest.sha256,
			signature: latest.signature
		};
	});
}

/** Each machine's update state, for the machine list, the machine pages and the Updates page. */
export function updateStates(
	database: Queryable,
	list: readonly { id: string; target: string; agentVersion: string }[],
	releases: ReleaseLookup,
	now: number
): Map<string, MachineUpdateState> {
	const ids = list.map((machine) => machine.id);
	const rows = new Map(
		(ids.length === 0
			? []
			: database.select().from(machineUpdates).where(inArray(machineUpdates.machineId, ids)).all()
		).map((row) => [row.machineId, row])
	);
	return new Map(
		list.map((machine) => {
			const latest = releases(machine.target);
			return [
				machine.id,
				machineUpdateState({
					agentVersion: machine.agentVersion,
					latest:
						latest === undefined ? { kind: 'none' } : { kind: 'version', version: latest.version },
					record: toRecord(rows.get(machine.id)),
					now
				})
			];
		})
	);
}

/** The newest signed version on the server, for any target: what the roll-out is about. */
export function newestVersion(
	releases: ReleaseLookup,
	targets: readonly string[]
): SignedRelease | undefined {
	return targets
		.map((target) => releases(target))
		.filter((release) => release !== undefined)
		.sort((a, b) => compareAgentVersions(b.version, a.version))
		.at(0);
}

export type RolloutView =
	| { kind: 'none' }
	| {
			kind: 'rollout';
			version: string;
			stage: RolloutStage;
			startedIso: string;
			stageStartedIso: string;
			paused:
				| { kind: 'running' }
				| { kind: 'paused'; reason: string; atIso: string; by: 'system' | 'admin' };
	  };

/** The roll-out of the newest version, moved on to now. */
export function rolloutView(
	database: AppDatabase,
	version: string | undefined,
	now: number
): RolloutView {
	if (version === undefined) {
		return { kind: 'none' };
	}
	const rollout = database.transaction((tx) => currentRollout(tx, version, now));
	return {
		kind: 'rollout',
		version,
		stage: rollout.stage,
		startedIso: rollout.startedAt.toISOString(),
		stageStartedIso: rollout.stageStartedAt.toISOString(),
		paused:
			rollout.pausedAt === null
				? { kind: 'running' }
				: {
						kind: 'paused',
						reason: rollout.pausedReason ?? '',
						atIso: rollout.pausedAt.toISOString(),
						by: rollout.pausedBy === null ? 'system' : 'admin'
					}
	};
}

/** How many machines are in the Early updates group (0 when there is no such group). */
export function earlyGroupSize(database: Queryable): number {
	return earlyMachineIds(database).size;
}

/** Pause by an admin. False if it was already paused. */
export function pauseRollout(
	database: AppDatabase,
	version: string,
	userId: string,
	now: number
): boolean {
	return database.transaction((tx) =>
		pause(tx, version, 'Paused by an admin', { kind: 'user', userId }, null, now)
	);
}

/** Resume: the current stage gets a fresh hour. False if it was not paused. */
export function resumeRollout(
	database: AppDatabase,
	version: string,
	userId: string,
	now: number
): boolean {
	return database.transaction((tx) => {
		const rollout = currentRollout(tx, version, now);
		if (rollout.pausedAt === null) {
			return false;
		}
		tx.update(agentRollouts)
			.set({ pausedAt: null, pausedReason: null, pausedBy: null, stageStartedAt: new Date(now) })
			.where(eq(agentRollouts.version, version))
			.run();
		recordAudit(
			tx,
			{
				actor: { kind: 'user', userId },
				kind: 'agent-rollout-resumed',
				target: `Version ${version}`,
				machineId: null,
				detail: { 'paused because': rollout.pausedReason ?? '' }
			},
			now
		);
		return true;
	});
}

function activeMachine(
	database: Queryable,
	machineId: string
): { id: string; name: string; target: string; agentVersion: string } | undefined {
	return database
		.select({
			id: machines.id,
			name: machines.name,
			target: machines.target,
			agentVersion: machines.agentVersion
		})
		.from(machines)
		.where(and(eq(machines.id, machineId), isNull(machines.removedAt)))
		.get();
}

/** Pins or unpins a machine's agent version. False for an unknown machine. */
export function setPinned(
	database: AppDatabase,
	machineId: string,
	pinned: boolean,
	userId: string,
	now: number
): boolean {
	return database.transaction((tx) => {
		const machine = activeMachine(tx, machineId);
		if (machine === undefined) {
			return false;
		}
		const row = updateRow(tx, machineId);
		const already = row !== undefined && row.pinnedAt !== null;
		if (already === pinned) {
			return true;
		}
		upsert(
			tx,
			machineId,
			pinned ? { pinnedAt: new Date(now), pinnedBy: userId } : { pinnedAt: null, pinnedBy: null }
		);
		recordAudit(
			tx,
			{
				actor: { kind: 'user', userId },
				kind: pinned ? 'agent-pinned' : 'agent-unpinned',
				target: machine.name,
				machineId,
				detail: { version: machine.agentVersion }
			},
			now
		);
		return true;
	});
}

export type UpdateNowResult = {
	/** Ids of machines that will update at their next check-in. */
	requested: string[];
	skipped: { name: string; reason: string }[];
};

/**
 * Update now (one, a selection, or every machine): jumps the queue, a pause,
 * Manual mode and an earlier failure. Pinned machines, agents without the
 * launcher and machines already up to date are skipped with the reason.
 */
export function requestUpdates(
	database: AppDatabase,
	machineIds: readonly string[],
	releases: ReleaseLookup,
	userId: string,
	now: number
): UpdateNowResult {
	return database.transaction((tx) => {
		const result: UpdateNowResult = { requested: [], skipped: [] };
		for (const machineId of machineIds) {
			const machine = activeMachine(tx, machineId);
			if (machine === undefined) {
				continue;
			}
			const record = toRecord(updateRow(tx, machineId));
			const latest = releases(machine.target);
			const skip = (reason: string): void => {
				result.skipped.push({ name: machine.name, reason });
			};
			if (latest === undefined) {
				skip('no signed build for this kind of computer');
			} else if (!isOlderAgent(machine.agentVersion, latest.version)) {
				skip('already up to date');
			} else if (record.pinned) {
				skip('pinned');
			} else if (!record.launcher) {
				skip('installed before automatic updates; reinstall it once');
			} else {
				upsert(tx, machineId, { requestedVersion: latest.version, requestedAt: new Date(now) });
				recordAudit(
					tx,
					{
						actor: { kind: 'user', userId },
						kind: 'agent-update-requested',
						target: machine.name,
						machineId,
						detail: { from: machine.agentVersion, to: latest.version }
					},
					now
				);
				result.requested.push(machineId);
			}
		}
		return result;
	});
}

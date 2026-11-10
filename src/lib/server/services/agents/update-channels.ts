import { and, eq, isNull } from 'drizzle-orm';
import type { UpdateChannel, UpdateGroup } from '#lib/domain/machines/agent-updates.ts';
import { compareAgentVersions } from '#lib/domain/machines/agent-version.ts';
import { machineGroupMembers, machineGroups, machines } from '../../database/schema.ts';
import type { Queryable } from '../../database/connection.ts';
import type { ReleaseLookup, SignedRelease } from './releases.ts';

/**
 * Who follows which builds (SPEC-AGENT-UPDATES, SPEC-TEST-CHANNEL): the
 * built-in Early updates and Test groups, found by `built_in`, never by name,
 * and the build each machine is offered.
 */

/** The machines (not removed) in a built-in update group. */
export function builtInGroupMachineIds(
	database: Queryable,
	builtIn: 'early' | 'test'
): Set<string> {
	const rows = database
		.select({ machineId: machineGroupMembers.machineId })
		.from(machineGroupMembers)
		.innerJoin(machineGroups, eq(machineGroups.id, machineGroupMembers.machineGroupId))
		.innerJoin(machines, eq(machines.id, machineGroupMembers.machineId))
		.where(and(eq(machineGroups.builtIn, builtIn), isNull(machines.removedAt)))
		.all();
	return new Set(rows.map((row) => row.machineId));
}

/** The build a machine follows: the newest test build if it is in Test and that is newer, else the newest full one. */
export function releaseFor(
	releases: ReleaseLookup,
	target: string,
	inTestGroup: boolean
): { channel: UpdateChannel; release: SignedRelease } | undefined {
	const full = releases.full(target);
	const test = inTestGroup ? releases.test(target) : undefined;
	if (
		test !== undefined &&
		(full === undefined || compareAgentVersions(test.version, full.version) > 0)
	) {
		return { channel: 'test', release: test };
	}
	return full === undefined ? undefined : { channel: 'full', release: full };
}

/**
 * A built-in update group and how many machines are in it, for the Updates
 * page. The migrations make both groups, so a database without one is broken.
 */
export function updateGroup(database: Queryable, builtIn: 'early' | 'test'): UpdateGroup {
	const group = database
		.select({ id: machineGroups.id, name: machineGroups.name })
		.from(machineGroups)
		.where(eq(machineGroups.builtIn, builtIn))
		.get();
	if (group === undefined) {
		throw new Error(`The built-in ${builtIn} machine group is missing; run the migrations.`);
	}
	return { ...group, machines: builtInGroupMachineIds(database, builtIn).size };
}

/** The newest build `lookup` has for any target: what a roll-out or the Test channel is about. */
export function newestVersion(
	lookup: (target: string) => SignedRelease | undefined,
	targets: readonly string[]
): SignedRelease | undefined {
	return targets
		.map((target) => lookup(target))
		.filter((release) => release !== undefined)
		.sort((a, b) => compareAgentVersions(b.version, a.version))
		.at(0);
}

/** The newest test build on this server and the machines (not removed) that run it. */
export type TestBuildView =
	{ kind: 'none' } | { kind: 'build'; version: string; machines: { id: string; name: string }[] };

export function testBuildView(
	database: Queryable,
	releases: ReleaseLookup,
	targets: readonly string[]
): TestBuildView {
	const newest = newestVersion(releases.test, targets);
	if (newest === undefined) {
		return { kind: 'none' };
	}
	const running = database
		.select({ id: machines.id, name: machines.name })
		.from(machines)
		.where(and(eq(machines.agentVersion, newest.version), isNull(machines.removedAt)))
		.orderBy(machines.name)
		.all();
	return { kind: 'build', version: newest.version, machines: running };
}

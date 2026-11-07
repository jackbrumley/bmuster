import type { ReleaseLookup } from '../agents/releases.ts';
import { consentLabel, permissionLabel } from '#lib/domain/access/access.ts';
import { activityLabel, type ActivityEntry } from '#lib/domain/activity/activity.ts';
import { activitySentence } from '#lib/domain/activity/local-page-activity.ts';
import { osLabel, type Machine } from '#lib/domain/machines/machine.ts';
import {
	machinesInOrder,
	machinesMatching,
	toMachineRow
} from '#lib/domain/machines/machine-row.ts';
import { roleLabel, signInSummary, type ConsoleUser } from '#lib/domain/users/user.ts';
import type { ActivityExportQuery, MachinesExportQuery } from '#lib/schemas/exports/exports.ts';
import type { AppDatabase } from '../../database/connection.ts';
import { activityScopeFor, canSeeGroups, visibleMachineIds } from '../access/access.ts';
import { listMachineGroups, listUserGroups } from '../access/groups.ts';
import { listAccessRules } from '../access/rules.ts';
import { listAuditBetween, recordAudit } from '../audit/audit.ts';
import { activeMachineNames, listMachines } from '../machines/machine-views.ts';
import { withActorNames } from '../users/activity-feed.ts';
import { listUsers } from '../users/users.ts';
import type { CsvCell, CsvFile } from './csv.ts';

/**
 * The list exports (SPEC-CSV-EXPORT): each builds the rows the viewer may
 * see, through the same services and access checks as the page, and audits
 * the export (X8) with who, which list, how many rows and the filters used.
 */

type ExportList = 'machines' | 'users' | 'groups' | 'access-rules' | 'activity';

type ListExport = CsvFile;

/** Activity rows per export (X7); more are cut off with a note as the last line. */
export const ACTIVITY_EXPORT_CAP = 100_000;

/** Lists inside one cell. */
const JOIN = '; ';

function listLabel(list: ExportList): string {
	switch (list) {
		case 'machines':
			return 'Machines';
		case 'users':
			return 'Users';
		case 'groups':
			return 'Groups';
		case 'access-rules':
			return 'Access rules';
		case 'activity':
			return 'Activity';
	}
}

/** The server's local date, as the file name shows it: bmuster-machines-2026-11-07.csv. */
function exportFilename(list: ExportList, now: number): string {
	const date = new Date(now);
	const pad = (value: number): string => String(value).padStart(2, '0');
	return `bmuster-${list}-${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}.csv`;
}

function finish(
	database: AppDatabase,
	user: ConsoleUser,
	list: ExportList,
	table: { header: string[]; rows: CsvCell[][]; dataRows: number; filters: Record<string, string> },
	now: number
): ListExport {
	recordAudit(
		database,
		{
			actor: { kind: 'user', userId: user.id },
			kind: 'list-exported',
			target: listLabel(list),
			machineId: null,
			detail: { rows: String(table.dataRows), ...table.filters }
		},
		now
	);
	return { filename: exportFilename(list, now), header: table.header, rows: table.rows };
}

/** Group names by machine id, for admins; chosen groups only (All machines holds every one). */
function machineGroupsById(database: AppDatabase): Map<string, string[]> {
	const byMachine = new Map<string, string[]>();
	for (const group of listMachineGroups(database)) {
		if (group.membership.kind === 'chosen') {
			for (const machineId of group.membership.machineIds) {
				byMachine.set(machineId, [...(byMachine.get(machineId) ?? []), group.name]);
			}
		}
	}
	return byMachine;
}

/** Machines (X5, X6): every machine the viewer may see that matches the search and filter, in screen order. */
export function exportMachines(
	database: AppDatabase,
	user: ConsoleUser,
	query: MachinesExportQuery,
	now: number,
	releases: ReleaseLookup
): ListExport {
	const visible = visibleMachineIds(database, user);
	const rows = listMachines(database, now, releases)
		.filter((machine) => visible.has(machine.id))
		.map(toMachineRow);
	const shown = machinesInOrder(
		machinesMatching(rows, query.search, query.filter),
		query.order,
		now
	);
	const groups = canSeeGroups(user)
		? { kind: 'shown' as const, byMachine: machineGroupsById(database) }
		: { kind: 'hidden' as const };
	const header = [
		'Name',
		'Host',
		'Status',
		'OS',
		'OS version',
		'CPU %',
		'Memory %',
		'Disk % (fullest)',
		'Last user',
		'Last seen',
		...(groups.kind === 'shown' ? ['Groups'] : []),
		'Agent version',
		'Description'
	];
	const lines = shown.map(({ machine, cpuPercent, memoryPercent, disk }): CsvCell[] => [
		machine.name,
		machine.hostname,
		machine.status.kind === 'online' ? 'Online' : 'Offline',
		osName(machine),
		machine.inventory.kind === 'known' ? machine.inventory.osVersion : null,
		cpuPercent,
		memoryPercent,
		disk === undefined ? null : disk.percent,
		machine.lastUser.kind === 'user' ? machine.lastUser.name : null,
		machine.lastSeenIso,
		...(groups.kind === 'shown' ? [(groups.byMachine.get(machine.id) ?? []).join(JOIN)] : []),
		machine.agentVersion,
		machine.description
	]);
	const search = query.search.trim();
	const filters = {
		...(search === '' ? {} : { search }),
		...(query.filter === 'all' ? {} : { filter: query.filter }),
		...(query.order.kind === 'column'
			? { sort: `${query.order.column} ${query.order.direction}` }
			: {})
	};
	return finish(
		database,
		user,
		'machines',
		{ header, rows: lines, dataRows: lines.length, filters },
		now
	);
}

/** "Ubuntu" once the inventory is in, else the family ("Linux"). */
function osName(machine: Machine): string {
	return machine.inventory.kind === 'known' ? machine.inventory.osName : osLabel(machine);
}

/** Users (admins only, X5). */
export function exportUsers(database: AppDatabase, user: ConsoleUser, now: number): ListExport {
	const groups = listUserGroups(database);
	const header = ['Name', 'Email', 'Role', 'Sign-in method', 'Groups', 'Last sign-in', 'Disabled'];
	const rows = listUsers(database).map((person): CsvCell[] => [
		person.name,
		person.email,
		roleLabel(person.role),
		signInSummary(person),
		groups
			.filter((group) => group.memberIds.includes(person.id))
			.map((group) => group.name)
			.join(JOIN),
		person.lastSignIn.kind === 'at' ? person.lastSignIn.iso : null,
		person.status.kind === 'disabled' ? 'Yes' : 'No'
	]);
	return finish(database, user, 'users', { header, rows, dataRows: rows.length, filters: {} }, now);
}

/** Groups of people, then groups of machines (admins only, X5). */
export function exportGroups(database: AppDatabase, user: ConsoleUser, now: number): ListExport {
	const people = new Map(listUsers(database).map((person) => [person.id, person.name]));
	const machines = activeMachineNames(database);
	const named = (ids: readonly string[], names: Map<string, string>): string[] =>
		ids.flatMap((id) => {
			const name = names.get(id);
			return name === undefined ? [] : [name];
		});
	const header = ['Name', 'Kind', 'Member count', 'Members'];
	const userRows = listUserGroups(database).map((group): CsvCell[] => {
		const members = named(group.memberIds, people);
		return [group.name, 'People', members.length, members.join(JOIN)];
	});
	const machineRows = listMachineGroups(database).map((group): CsvCell[] => {
		const members =
			group.membership.kind === 'all-machines'
				? [...machines.values()]
				: named(group.membership.machineIds, machines);
		return [group.name, 'Machines', members.length, members.join(JOIN)];
	});
	const rows = [...userRows, ...machineRows];
	return finish(
		database,
		user,
		'groups',
		{ header, rows, dataRows: rows.length, filters: {} },
		now
	);
}

/** Access rules (admins only, X5): who may do what on which machines. */
export function exportAccessRules(
	database: AppDatabase,
	user: ConsoleUser,
	now: number
): ListExport {
	const userGroups = new Map(listUserGroups(database).map((group) => [group.id, group.name]));
	const machineGroups = new Map(listMachineGroups(database).map((group) => [group.id, group.name]));
	const nameOf = (names: Map<string, string>, id: string): string => {
		const name = names.get(id);
		if (name === undefined) {
			throw new Error(`Access rule points at a missing group: ${id}`);
		}
		return name;
	};
	const header = ['Who', 'What machines', 'Permissions', 'Consent'];
	const rows = listAccessRules(database).map((rule): CsvCell[] => [
		nameOf(userGroups, rule.userGroupId),
		nameOf(machineGroups, rule.machineGroupId),
		rule.permissions.map(permissionLabel).join(JOIN),
		consentLabel(rule.consent)
	]);
	return finish(
		database,
		user,
		'access-rules',
		{ header, rows, dataRows: rows.length, filters: {} },
		now
	);
}

/** "2026-11-07 15:04:05" in the viewer's time zone. */
function localTime(zone: string): (iso: string) => string {
	const format = new Intl.DateTimeFormat('en-AU', {
		timeZone: zone,
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
		hour: '2-digit',
		minute: '2-digit',
		second: '2-digit',
		hourCycle: 'h23'
	});
	return (iso) => {
		const parts = new Map(
			format.formatToParts(new Date(iso)).map((part) => [part.type, part.value])
		);
		const part = (type: Intl.DateTimeFormatPartTypes): string => parts.get(type) ?? '';
		return `${part('year')}-${part('month')}-${part('day')} ${part('hour')}:${part('minute')}:${part('second')}`;
	};
}

function activityAction(entry: ActivityEntry): string {
	const sentence = activitySentence(entry);
	switch (sentence.kind) {
		case 'local':
			return sentence.text;
		case 'standard':
			return activityLabel(entry.kind);
	}
}

/**
 * Activity (X5, X7): newest first, only entries the viewer may read, within
 * the range, up to ACTIVITY_EXPORT_CAP rows. A cut-off export says so on its
 * last line.
 */
export function exportActivity(
	database: AppDatabase,
	user: ConsoleUser,
	query: ActivityExportQuery,
	now: number
): ListExport {
	const range = {
		fromMs: query.from.kind === 'at' ? query.from.ms : 0,
		toMs: query.to.kind === 'at' ? query.to.ms : now
	};
	const records = listAuditBetween(
		database,
		activityScopeFor(database, user),
		range,
		ACTIVITY_EXPORT_CAP + 1
	);
	const cutOff = records.length > ACTIVITY_EXPORT_CAP;
	const entries = withActorNames(database, records.slice(0, ACTIVITY_EXPORT_CAP));
	const local = localTime(query.timeZone);
	const header = [
		'Time (ISO)',
		`Time (local, ${query.timeZone})`,
		'Actor',
		'Action',
		'Target',
		'IP',
		'Details'
	];
	const rows = entries.map((entry): CsvCell[] => [
		entry.atIso,
		local(entry.atIso),
		entry.actor.kind === 'user' ? entry.actor.name : 'System',
		activityAction(entry),
		entry.target,
		entry.detail.find((item) => item.label === 'ip')?.value ?? null,
		entry.detail
			.filter((item) => item.label !== 'ip')
			.map((item) => `${item.label}: ${item.value}`)
			.join(JOIN)
	]);
	const oldest = entries.at(-1);
	const note: CsvCell[][] =
		cutOff && oldest !== undefined
			? [
					[
						`Cut off at ${ACTIVITY_EXPORT_CAP} rows: older entries than ${oldest.atIso} are not in this file.`
					]
				]
			: [];
	const filters = {
		timeZone: query.timeZone,
		...(query.from.kind === 'at' ? { from: new Date(query.from.ms).toISOString() } : {}),
		...(query.to.kind === 'at' ? { to: new Date(query.to.ms).toISOString() } : {}),
		...(cutOff ? { cutOff: 'yes' } : {})
	};
	return finish(
		database,
		user,
		'activity',
		{ header, rows: [...rows, ...note], dataRows: rows.length, filters },
		now
	);
}

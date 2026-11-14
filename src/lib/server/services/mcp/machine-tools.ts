import { activityLabel } from '#lib/domain/activity/activity.ts';
import { shellsFor, type Machine } from '#lib/domain/machines/machine.ts';
import type {
	GetMachineOutput,
	ListMachinesOutput,
	getMachineInput,
	listMachinesInput
} from '#lib/schemas/mcp/tools.ts';
import type { z } from 'zod';
import type { AppDatabase } from '../../database/connection.ts';
import { canSeeGroups, machineIdsWith } from '../access/access.ts';
import { listMachineGroups } from '../access/groups.ts';
import type { ReleaseLookup } from '../agents/releases.ts';
import { listAuditForMachines, recordAudit } from '../audit/audit.ts';
import { listMachines } from '../machines/machine-views.ts';
import { viaDetail } from '../oauth/grants.ts';
import type { McpPrincipal } from '../oauth/tokens.ts';
import { withActorNames } from '../users/activity-feed.ts';

/**
 * The read tools (SPEC-MCP 9.1, 9.2, M11, M12): only machines where the person holds
 * `ai-commands`, never removed ones, and only inventory. Each call is audited with the person as
 * actor and the assistant as `via` (M13).
 */

export type ToolContext = {
	database: AppDatabase;
	principal: McpPrincipal;
	releases: ReleaseLookup;
	now: number;
};

export type ToolResult<T> = { kind: 'ok'; output: T } | { kind: 'error'; message: string };

const NEEDS_SCOPE = 'This connection was not allowed to read machines (scope machines:read).';

/** The machines this person's assistant may see, by name. */
function aiMachines(context: ToolContext): Machine[] {
	const allowed = machineIdsWith(context.database, context.principal.user, 'ai-commands');
	return listMachines(context.database, context.now, context.releases).filter((machine) =>
		allowed.has(machine.id)
	);
}

/** Group names per machine, for admins only: members do not see groups (SPEC-ACCESS A1–A3). */
function groupNames(context: ToolContext): (machineId: string) => string[] {
	if (!canSeeGroups(context.principal.user)) {
		return () => [];
	}
	const groups = listMachineGroups(context.database);
	return (machineId) =>
		groups
			.filter((group) =>
				group.membership.kind === 'all-machines'
					? true
					: group.membership.machineIds.includes(machineId)
			)
			.map((group) => group.name);
}

function audit(
	context: ToolContext,
	tool: string,
	about: { target: string; machineId: string | null }
): void {
	recordAudit(
		context.database,
		{
			actor: { kind: 'user', userId: context.principal.user.id },
			kind: 'mcp-tool-called',
			target: about.target,
			machineId: about.machineId,
			detail: { tool, ...viaDetail(context.principal.assistant, context.principal.clientId) }
		},
		context.now
	);
}

function osVersionOf(machine: Machine): string {
	return machine.inventory.kind === 'known'
		? `${machine.inventory.osName} ${machine.inventory.osVersion}`.trim()
		: '';
}

export function listMachinesTool(
	context: ToolContext,
	input: z.infer<typeof listMachinesInput>
): ToolResult<ListMachinesOutput> {
	if (!context.principal.scopes.includes('machines:read')) {
		return { kind: 'error', message: NEEDS_SCOPE };
	}
	const search = input.search.trim().toLowerCase();
	const groupsOf = groupNames(context);
	const matching = aiMachines(context).filter(
		(machine) =>
			(search === '' ||
				machine.name.toLowerCase().includes(search) ||
				machine.hostname.toLowerCase().includes(search)) &&
			(input.status === 'any' || (input.status === 'online') === (machine.status.kind === 'online'))
	);
	audit(context, 'list_machines', {
		target: `${String(matching.length)} machines`,
		machineId: null
	});
	return {
		kind: 'ok',
		output: {
			total: matching.length,
			machines: matching.slice(0, input.limit).map((machine) => ({
				id: machine.id,
				name: machine.name,
				hostname: machine.hostname,
				os: machine.osFamily,
				osVersion: osVersionOf(machine),
				status: machine.status.kind,
				lastSeenAt: machine.lastSeenIso,
				shells: shellsFor(machine.osFamily).map((shell) => shell.id),
				groups: groupsOf(machine.id)
			}))
		}
	};
}

/** A machine by id, or by a name no other visible machine shares. */
function findByName(machines: readonly Machine[], wanted: string): Machine | string {
	const byId = machines.find((machine) => machine.id === wanted);
	if (byId !== undefined) {
		return byId;
	}
	const named = machines.filter((machine) => machine.name.toLowerCase() === wanted.toLowerCase());
	if (named.length === 1 && named[0] !== undefined) {
		return named[0];
	}
	return named.length > 1
		? `More than one machine is called ${wanted}. Use its id from list_machines.`
		: `No machine called ${wanted} is open to you. Use list_machines to see the ones that are.`;
}

export function getMachineTool(
	context: ToolContext,
	input: z.infer<typeof getMachineInput>
): ToolResult<GetMachineOutput> {
	if (!context.principal.scopes.includes('machines:read')) {
		return { kind: 'error', message: NEEDS_SCOPE };
	}
	const found = findByName(aiMachines(context), input.machine.trim());
	if (typeof found === 'string') {
		return { kind: 'error', message: found };
	}
	const machine = found;
	const inventory = machine.inventory.kind === 'known' ? machine.inventory : undefined;
	const live = machine.live.kind === 'known' ? machine.live : undefined;
	const memoryTotal = inventory?.memoryTotalBytes ?? null;
	const recent = withActorNames(
		context.database,
		listAuditForMachines(context.database, [machine.id], 20)
	);
	audit(context, 'get_machine', { target: machine.name, machineId: machine.id });
	return {
		kind: 'ok',
		output: {
			id: machine.id,
			name: machine.name,
			hostname: machine.hostname,
			os: machine.osFamily,
			osVersion: osVersionOf(machine),
			kernel: inventory?.osBuild ?? '',
			architecture: machine.target.split('-')[0] ?? '',
			status: machine.status.kind,
			lastSeenAt: machine.lastSeenIso,
			uptimeSeconds: live?.uptimeSeconds ?? null,
			cpuPercent: live?.cpuPercent ?? null,
			memory: {
				totalBytes: memoryTotal,
				usedPercent:
					memoryTotal !== null && memoryTotal > 0 && live !== undefined
						? Math.round((live.memoryUsedBytes / memoryTotal) * 1000) / 10
						: null
			},
			disks: (inventory?.disks ?? []).map((disk) => ({
				mount: disk.mount,
				totalBytes: disk.sizeBytes,
				freeBytes: disk.sizeBytes - disk.usedBytes
			})),
			lastUser: machine.lastUser.kind === 'user' ? machine.lastUser.name : null,
			agentVersion: machine.agentVersion,
			shells: shellsFor(machine.osFamily).map((shell) => shell.id),
			groups: groupNames(context)(machine.id),
			inUse: machine.inUse.map((session) => ({ kind: session.kind, by: session.userName })),
			// Who did what, without the entries' targets and details (which can hold email addresses).
			recentActivity: recent.map((entry) => ({
				at: entry.atIso,
				summary: `${entry.actor.kind === 'user' ? entry.actor.name : 'System'}: ${activityLabel(entry.kind)}`
			}))
		}
	};
}

/**
 * Who may do what on which machines (SPEC-ACCESS). Browser-safe.
 *
 * People are in user groups; machines are in machine groups (both many-to-many).
 * An access rule joins one user group to one machine group with a set of
 * permissions. A person's permissions on a machine are the union of every
 * rule that matches them both; there are no deny rules. Admins have every
 * permission on every machine except `ai-view` and `ai-commands`, which come only from rules
 * (SPEC-MCP M3, M35).
 */

/** Every permission, in the order the console lists them. A new one is added here only. */
export const PERMISSIONS = [
	'view',
	'terminal',
	'desktop-view',
	'desktop-control',
	'files',
	'share-links',
	// SPEC-COMMANDS C11: one command on many machines as root or SYSTEM. Nothing includes it.
	'run-commands',
	// SPEC-MCP M35: what an AI assistant acting as the person may see. Only ai-commands includes it.
	// Server-side only: the agent never checks it. Admins hold it only through rules.
	'ai-view',
	// SPEC-MCP M3, M36: where an AI assistant acting as the person may also ask to run commands,
	// each approved by a person. Server-side only, rules only, like ai-view.
	'ai-commands'
] as const;

export type Permission = (typeof PERMISSIONS)[number];

export function permissionLabel(permission: Permission): string {
	switch (permission) {
		case 'view':
			return 'See inventory';
		case 'terminal':
			return 'Terminal';
		case 'desktop-view':
			return 'Watch desktop';
		case 'desktop-control':
			return 'Control desktop';
		case 'files':
			return 'Files';
		case 'share-links':
			return 'Share links';
		case 'run-commands':
			return 'Run commands';
		case 'ai-view':
			return 'AI can view';
		case 'ai-commands':
			return 'AI commands (with approval)';
	}
}

/** One line under each permission on the rule form (SPEC-MCP M40). */
export function permissionAbout(permission: Permission): string {
	switch (permission) {
		case 'view':
			return 'See the machine in the list, its inventory and its activity.';
		case 'terminal':
			return 'Open a terminal on the machine.';
		case 'desktop-view':
			return 'Watch the screen, without control.';
		case 'desktop-control':
			return 'Use the mouse and keyboard on the screen.';
		case 'files':
			return 'Browse, download and upload files.';
		case 'share-links':
			return 'Make links that let someone without an account in for a while.';
		case 'run-commands':
			return 'Run one command on many machines at once, as root or SYSTEM.';
		case 'ai-view':
			return 'An AI assistant acting as the person can see the machine, but cannot ask to run anything.';
		case 'ai-commands':
			return 'The assistant can also ask to run commands there; each waits for a person to approve it.';
	}
}

/**
 * What a permission includes besides itself: every other one includes `view`; control includes
 * watching; AI commands includes AI can view (SPEC-MCP M36).
 */
function includedBy(permission: Permission): Permission[] {
	switch (permission) {
		case 'view':
			return [];
		case 'desktop-control':
			return ['view', 'desktop-view'];
		case 'ai-commands':
			return ['view', 'ai-view'];
		case 'terminal':
		case 'desktop-view':
		case 'files':
		case 'share-links':
		case 'run-commands':
		case 'ai-view':
			return ['view'];
	}
}

/**
 * A stored permission set with what each permission includes added, in PERMISSIONS order. Rules
 * are saved complete, but "complete" grows when an inclusion is added: a rule saved by 0.4.32 as
 * `view` and `ai-commands` reads as giving `ai-view` too (SPEC-MCP M36), with no migration.
 */
export function withIncluded(permissions: readonly Permission[]): Permission[] {
	return PERMISSIONS.filter(
		(candidate) =>
			permissions.includes(candidate) ||
			permissions.some((held) => includedBy(held).includes(candidate))
	);
}

/** True when every permission's inclusions are in the set too, and it is not empty. */
export function isCompletePermissionSet(permissions: readonly Permission[]): boolean {
	return (
		permissions.length > 0 &&
		permissions.every((permission) =>
			includedBy(permission).every((included) => permissions.includes(included))
		)
	);
}

/**
 * Ticking or unticking one permission on the rule form, keeping the set
 * complete: ticking adds what it includes; unticking removes what needs it.
 * Returned in PERMISSIONS order.
 */
export function togglePermission(
	permissions: readonly Permission[],
	permission: Permission,
	on: boolean
): Permission[] {
	const next = new Set(permissions);
	if (on) {
		next.add(permission);
		for (const included of includedBy(permission)) next.add(included);
	} else {
		next.delete(permission);
		for (const other of PERMISSIONS) {
			if (includedBy(other).includes(permission)) next.delete(other);
		}
	}
	return PERMISSIONS.filter((candidate) => next.has(candidate));
}

/** Before a session starts: ask the person at the screen, or connect straight away. */
export const CONSENTS = ['unattended', 'ask'] as const;

export type Consent = (typeof CONSENTS)[number];

export function consentLabel(consent: Consent): string {
	switch (consent) {
		case 'unattended':
			return 'Connects without asking (unattended)';
		case 'ask':
			return 'Asks the person at the screen first';
	}
}

/** One permission a person has on a machine, and whether using it asks first. */
export type Grant = { permission: Permission; consent: Consent };

export function hasPermission(grants: readonly Grant[], permission: Permission): boolean {
	return grants.some((grant) => grant.permission === permission);
}

/** A group of people (Groups page). */
export type UserGroupView = {
	id: string;
	name: string;
	description: string;
	/** User ids. */
	memberIds: string[];
};

/**
 * The machine groups BMuster makes itself, which cannot be renamed or
 * deleted: All machines (A3), Early updates (A11) and Test (SPEC-TEST-CHANNEL).
 */
export type BuiltInMachineGroup = 'all' | 'early' | 'test' | 'none';

/** One line on what a built-in group does, for its page. */
export function builtInGroupAbout(builtIn: Exclude<BuiltInMachineGroup, 'none'>): string {
	switch (builtIn) {
		case 'all':
			return 'Built in: every machine on this server, now and later. Machines cannot be added or taken out.';
		case 'early':
			return 'Built in: new agent versions reach these machines first, an hour before the rest. Add one or two test machines.';
		case 'test':
			return 'Built in: test builds reach these machines as soon as they are published, before the full release. Everyone else stays on full releases.';
	}
}

/**
 * A group of machines. The built-in All machines group always holds every
 * machine; its members are not stored and it cannot be changed by hand (A3).
 * The built-in Early updates group holds chosen machines like any other (A11).
 */
export type MachineGroupView = {
	id: string;
	name: string;
	description: string;
	builtIn: BuiltInMachineGroup;
	membership: { kind: 'all-machines' } | { kind: 'chosen'; machineIds: string[] };
};

export type AccessRuleView = {
	id: string;
	userGroupId: string;
	machineGroupId: string;
	permissions: Permission[];
	consent: Consent;
	createdIso: string;
};

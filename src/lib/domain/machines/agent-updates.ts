import { isOlderAgent } from './agent-version.ts';

/**
 * Agent updates (SPEC-AGENT-UPDATES): the rules for who gets a new version
 * when, and how a machine's update state is shown. Pure and browser-safe, so
 * the server, the console and the tests share one set of rules.
 */

export type UpdatePolicy = 'automatic' | 'manual';

/**
 * The built-in Early updates machine group (SPEC-ACCESS A11): its machines get
 * a new version first. Found by its built-in marker, so its name is only shown.
 */
export type EarlyUpdatesGroup = { id: string; name: string; machines: number };

/** Each roll-out stage lasts this long without a failure before the next starts. */
export const STAGE_MS = 60 * 60 * 1000;

/** An offer is shown as Updating for this long; then it counts as available again. */
export const UPDATING_MS = 15 * 60 * 1000;

/** Share of the machines outside the Early updates group in the second stage. */
const TENTH_PERCENT = 10;

export type RolloutStage = 'early' | 'tenth' | 'all';

export type RolloutTiming = { stage: RolloutStage; stageStartedAt: number };

/** The first stage of a new version: the Early updates group, if it has machines. */
export function firstStage(earlyMachines: number): RolloutStage {
	return earlyMachines > 0 ? 'early' : 'tenth';
}

/**
 * Moves a running roll-out on by the hours that passed (a paused one stays
 * put). Each stage starts an hour after the one before.
 */
export function advanceStage(timing: RolloutTiming, now: number): RolloutTiming {
	let { stage, stageStartedAt } = timing;
	while (stage !== 'all' && now - stageStartedAt >= STAGE_MS) {
		stage = stage === 'early' ? 'tenth' : 'all';
		stageStartedAt += STAGE_MS;
	}
	return { stage, stageStartedAt };
}

export function stageLabel(stage: RolloutStage): string {
	switch (stage) {
		case 'early':
			return 'Early updates group';
		case 'tenth':
			return '10% of machines';
		case 'all':
			return 'All machines';
	}
}

/** The last thing an agent reported about an update. */
export type UpdateEvent =
	| { kind: 'none' }
	| { kind: 'updated'; version: string; atIso: string }
	| { kind: 'rolled-back'; version: string; reason: string; atIso: string }
	| { kind: 'refused'; version: string; reason: string; atIso: string };

/** What the server knows about one machine's updates. */
export type UpdateRecord = {
	/** The agent runs under its launcher, so it can update itself. */
	launcher: boolean;
	pinned: boolean;
	/** An admin's Update now, for this version. */
	requested: { kind: 'none' } | { kind: 'version'; version: string };
	offered: { kind: 'none' } | { kind: 'version'; version: string; atMs: number };
	lastEvent: UpdateEvent;
};

export const NEW_UPDATE_RECORD: UpdateRecord = {
	launcher: false,
	pinned: false,
	requested: { kind: 'none' },
	offered: { kind: 'none' },
	lastEvent: { kind: 'none' }
};

/** One machine's update state, as the console shows it. */
export type MachineUpdateState =
	/** This server has no signed build for the machine's kind of computer. */
	| { kind: 'no-release' }
	| { kind: 'up-to-date' }
	| { kind: 'pinned'; available: { kind: 'none' } | { kind: 'version'; version: string } }
	/** `needsReinstall`: the agent predates the launcher and cannot update itself. */
	| { kind: 'available'; version: string; needsReinstall: boolean }
	| { kind: 'updating'; version: string }
	| { kind: 'rolled-back'; version: string; reason: string }
	| { kind: 'refused'; version: string; reason: string };

/** A failure the agent reported for `version`, if any. */
function failureFor(
	event: UpdateEvent,
	version: string
): { kind: 'rolled-back' | 'refused'; reason: string } | undefined {
	switch (event.kind) {
		case 'rolled-back':
		case 'refused':
			return event.version === version ? { kind: event.kind, reason: event.reason } : undefined;
		case 'none':
		case 'updated':
			return undefined;
	}
}

export function machineUpdateState(input: {
	agentVersion: string;
	/** The newest signed build for the machine's target. */
	latest: { kind: 'none' } | { kind: 'version'; version: string };
	record: UpdateRecord;
	now: number;
}): MachineUpdateState {
	const { agentVersion, latest, record, now } = input;
	const newer =
		latest.kind === 'version' && isOlderAgent(agentVersion, latest.version)
			? latest.version
			: undefined;
	if (record.pinned) {
		return {
			kind: 'pinned',
			available: newer === undefined ? { kind: 'none' } : { kind: 'version', version: newer }
		};
	}
	if (latest.kind === 'none') {
		return { kind: 'no-release' };
	}
	if (newer === undefined) {
		return { kind: 'up-to-date' };
	}
	const failure = failureFor(record.lastEvent, newer);
	if (failure !== undefined && record.requested.kind === 'none') {
		return { kind: failure.kind, version: newer, reason: failure.reason };
	}
	if (
		record.offered.kind === 'version' &&
		record.offered.version === newer &&
		now - record.offered.atMs < UPDATING_MS
	) {
		return { kind: 'updating', version: newer };
	}
	return { kind: 'available', version: newer, needsReinstall: !record.launcher };
}

/** The badge a machine card, table row and header show; none when up to date. */
export type UpdateBadge =
	| { kind: 'none' }
	| { kind: 'shown'; label: string; tone: 'warning' | 'danger' | 'brand' | 'muted' };

export function updateBadge(state: MachineUpdateState): UpdateBadge {
	switch (state.kind) {
		case 'no-release':
		case 'up-to-date':
			return { kind: 'none' };
		case 'pinned':
			return { kind: 'shown', label: 'Pinned', tone: 'muted' };
		case 'available':
			return { kind: 'shown', label: 'Update available', tone: 'warning' };
		case 'updating':
			return { kind: 'shown', label: 'Updating', tone: 'brand' };
		case 'rolled-back':
			return { kind: 'shown', label: 'Rolled back', tone: 'danger' };
		case 'refused':
			return { kind: 'shown', label: 'Update refused', tone: 'danger' };
	}
}

/** One sentence about the state, for the Agent panel and the Updates page. */
export function updateStateText(state: MachineUpdateState): string {
	switch (state.kind) {
		case 'no-release':
			return 'This server has no signed agent build for this kind of computer.';
		case 'up-to-date':
			return 'Up to date.';
		case 'pinned':
			return state.available.kind === 'version'
				? `Pinned to its version; ${state.available.version} is available.`
				: 'Pinned to its version.';
		case 'available':
			return state.needsReinstall
				? `Version ${state.version} is available, but this agent was installed before automatic updates and cannot update itself. Reinstall it once.`
				: `Version ${state.version} is available.`;
		case 'updating':
			return `Updating to ${state.version}.`;
		case 'rolled-back':
			return `Rolled back from ${state.version}: ${state.reason}.`;
		case 'refused':
			return `Refused ${state.version}: ${state.reason}.`;
	}
}

/** Whether this check-in gets an offer of `latest`. */
export function shouldOffer(input: {
	agentVersion: string;
	latest: string;
	record: UpdateRecord;
	policy: UpdatePolicy;
	rollout: { paused: boolean; stage: RolloutStage };
	inEarlyGroup: boolean;
	bucket: number;
}): boolean {
	const { agentVersion, latest, record, policy, rollout } = input;
	if (!record.launcher || record.pinned || !isOlderAgent(agentVersion, latest)) {
		return false;
	}
	// Update now jumps the queue, a pause, Manual mode and an earlier failure.
	if (record.requested.kind === 'version' && record.requested.version === latest) {
		return true;
	}
	if (policy === 'manual' || rollout.paused || failureFor(record.lastEvent, latest) !== undefined) {
		return false;
	}
	switch (rollout.stage) {
		case 'early':
			return input.inEarlyGroup;
		case 'tenth':
			return input.inEarlyGroup || input.bucket < TENTH_PERCENT;
		case 'all':
			return true;
	}
}

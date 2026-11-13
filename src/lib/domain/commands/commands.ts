/**
 * Commands (SPEC-COMMANDS): one command run on many machines at once, as root or SYSTEM,
 * with the results kept on the server. Browser-safe: the limits both sides check, the
 * statuses and their labels, and the shapes the run pages show.
 */
import type { TerminalShell } from '#lib/domain/sessions/session.ts';

/** The systems a command can be written for; macOS machines are skipped for now. */
export const COMMAND_OS_FAMILIES = ['windows', 'linux'] as const;

export type CommandOsFamily = (typeof COMMAND_OS_FAMILIES)[number];

/** The shells each system offers, the default first (C6). */
export const COMMAND_SHELLS = {
	windows: ['powershell', 'cmd'],
	linux: ['sh', 'bash']
} as const satisfies Record<CommandOsFamily, readonly TerminalShell[]>;

export type CommandShell = (typeof COMMAND_SHELLS)[CommandOsFamily][number];

export function commandShellLabel(shell: CommandShell): string {
	switch (shell) {
		case 'powershell':
			return 'PowerShell';
		case 'cmd':
			return 'cmd';
		case 'sh':
			return 'sh';
		case 'bash':
			return 'bash';
	}
}

export function commandOsLabel(family: CommandOsFamily): string {
	switch (family) {
		case 'windows':
			return 'Windows';
		case 'linux':
			return 'Linux';
	}
}

/** The limits of C7, C9, C10, C14 and C16, the same on the form and the server. */
export const COMMAND_LIMITS = {
	maxCommandChars: 8000,
	minTimeoutMs: 5_000,
	maxTimeoutMs: 10 * 60_000,
	defaultTimeoutMs: 60_000,
	/** Output kept per stream per machine; the rest is dropped and the stream marked cut off. */
	maxOutputBytesPerStream: 1024 * 1024,
	/** Machines running at once in one run (C14). */
	maxRunning: 10,
	/** Above this many machines, the count must be typed to confirm (C9). */
	typedCountAbove: 10,
	/** A run needs a password check (or a fresh sign-in) this recent (C10). */
	recentSignInMs: 10 * 60_000,
	/** Output is deleted this long after a run (C16); the rows and exit codes stay. */
	outputKeptMs: 30 * 24 * 60 * 60_000
} as const;

/**
 * The first agent version that runs a ticket carrying `run-commands` (SPEC-COMMANDS 6).
 * `-0` lets this release's own test and development builds through.
 */
export const FIRST_COMMANDS_AGENT = '0.4.26-0';

/** Where one machine of a run is up to (C16). */
export const RUN_MACHINE_STATUSES = [
	'waiting',
	'running',
	'succeeded',
	'failed',
	'timed-out',
	'offline',
	'skipped',
	'lost',
	'cancelled'
] as const;

export type RunMachineStatus = (typeof RUN_MACHINE_STATUSES)[number];

export function runMachineStatusLabel(status: RunMachineStatus): string {
	switch (status) {
		case 'waiting':
			return 'Waiting';
		case 'running':
			return 'Running';
		case 'succeeded':
			return 'Succeeded';
		case 'failed':
			return 'Failed';
		case 'timed-out':
			return 'Timed out';
		case 'offline':
			return 'Offline';
		case 'skipped':
			return 'Skipped';
		case 'lost':
			return 'Lost';
		case 'cancelled':
			return 'Cancelled';
	}
}

/** Still to finish: the run is not over while any machine is in one of these. */
export function isUnfinished(status: RunMachineStatus): boolean {
	switch (status) {
		case 'waiting':
		case 'running':
			return true;
		case 'succeeded':
		case 'failed':
		case 'timed-out':
		case 'offline':
		case 'skipped':
		case 'lost':
		case 'cancelled':
			return false;
	}
}

/** What **Run again on failed and offline** picks up (C18). */
export function needsRunAgain(status: RunMachineStatus): boolean {
	switch (status) {
		case 'failed':
		case 'timed-out':
		case 'offline':
		case 'lost':
			return true;
		case 'waiting':
		case 'running':
		case 'succeeded':
		case 'skipped':
		case 'cancelled':
			return false;
	}
}

export const RUN_STATUSES = ['running', 'finished', 'cancelled'] as const;

export type RunStatus = (typeof RUN_STATUSES)[number];

/** Why a machine will not run, as Review shows it (C8). */
export type SkipReason = 'offline' | 'agent-too-old' | 'unsupported-system' | 'no-permission';

export function skipReasonLabel(reason: SkipReason): string {
	switch (reason) {
		case 'offline':
			return 'Offline';
		case 'agent-too-old':
			return 'Agent too old (update first)';
		case 'unsupported-system':
			return 'Commands run on Windows and Linux only';
		case 'no-permission':
			return 'You cannot run commands on it';
	}
}

/** One command, for one system in the run. */
export type CommandScript = { osFamily: CommandOsFamily; shell: CommandShell; command: string };

/** One machine on Review (C8). */
export type PlannedMachine = {
	id: string;
	name: string;
	osFamily: CommandOsFamily | 'macos';
	plan: { kind: 'runs' } | { kind: 'skipped'; reason: SkipReason };
};

/** The machines in a run with how far each got, counted for the top line (C16). */
export type RunCounts = Record<RunMachineStatus, number>;

export function emptyCounts(): RunCounts {
	return {
		waiting: 0,
		running: 0,
		succeeded: 0,
		failed: 0,
		'timed-out': 0,
		offline: 0,
		skipped: 0,
		lost: 0,
		cancelled: 0
	};
}

/** "19 succeeded · 1 failed · 1 offline": the statuses with any machines, in status order. */
export function countsLine(counts: RunCounts): string {
	const parts = RUN_MACHINE_STATUSES.filter((status) => counts[status] > 0).map(
		(status) => `${counts[status]} ${runMachineStatusLabel(status).toLowerCase()}`
	);
	return parts.length === 0 ? 'No machines' : parts.join(' · ');
}

/** The first line of a command, for the runs list (C20). */
export function firstLine(command: string): string {
	return command.split(/\r?\n/, 1)[0] ?? '';
}

/** One run on the Commands tab (C20). */
export type RunSummary = {
	id: string;
	startedBy: string;
	startedIso: string;
	status: RunStatus;
	/** The first line of each system's command. */
	commands: { osFamily: CommandOsFamily; firstLine: string }[];
	counts: RunCounts;
};

/** One machine's row on the results page (C16). */
export type RunMachineView = {
	machineId: string;
	machineName: string;
	status: RunMachineStatus;
	/** Why it was skipped, lost or could not run; '' when there is nothing to add. */
	reason: string;
	exitCode: number | null;
	durationMs: number | null;
	output: { kind: 'none' } | { kind: 'kept'; bytes: number } | { kind: 'deleted' };
};

/** A run's results page (C16). */
export type RunView = {
	id: string;
	startedBy: string;
	startedIso: string;
	endedIso: string | null;
	status: RunStatus;
	timeoutMs: number;
	scripts: CommandScript[];
	machines: RunMachineView[];
	counts: RunCounts;
	/** The person may cancel it (their own run, still going). */
	canCancel: boolean;
};

/** One machine's output (C16), as text: none before it finishes, deleted after 30 days. */
export type RunMachineOutput =
	| { kind: 'none' }
	| { kind: 'deleted' }
	| {
			kind: 'kept';
			stdout: string;
			stderr: string;
			stdoutTruncated: boolean;
			stderrTruncated: boolean;
	  };

/** What **Run command** starts from: the machines, and the commands when running again (C18). */
export type CommandDraft = {
	machineIds: string[];
	scripts: CommandScript[];
	timeoutMs: number;
	rerunOf: string | null;
};

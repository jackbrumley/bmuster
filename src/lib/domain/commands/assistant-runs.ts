/**
 * Commands an AI assistant asks for (SPEC-MCP step 2): each one waits for a person's approval in
 * the console. Browser-safe: the limits both sides check, who may approve, what the approval card
 * shows, and the console's live events.
 */
import type { SignInCheck } from '#lib/domain/auth/sign-in-check.ts';
import type { CommandOsFamily, CommandShell } from './commands.ts';

export const ASSISTANT_RUN_LIMITS = {
	/** Machines in one request (approval fatigue, SPEC-MCP 11.3). */
	maxMachines: 10,
	/** A request nobody decides on expires this long after it was made (M21). */
	expiresMs: 10 * 60_000,
	/** The longest wait a `get_command_result` call may ask for, in seconds (M23, 4.4). */
	maxWaitSeconds: 45,
	/** How long `run_command` waits, and the most `get_command_result` waits, for the run to end. */
	waitMs: 45_000,
	/** Output returned per stream per call; more pages with offsets (M23). */
	pageBytes: 16 * 1024,
	minTimeoutSeconds: 5,
	maxTimeoutSeconds: 600,
	defaultTimeoutSeconds: 60,
	maxReasonChars: 500,
	maxDenyNoteChars: 500,
	/** Per person (M24). */
	maxPending: 5,
	runCommandPerHour: 60,
	toolCallsPerHour: 600,
	/** Approve stays disabled this long after the card appears or changes (M25). */
	approveDelayMs: 2_000
} as const;

/** Who may approve an assistant's request (M19, setting `mcp.approvers`). */
export const APPROVER_MODES = ['requester', 'requester-or-group', 'group-only'] as const;

export type ApproverMode = (typeof APPROVER_MODES)[number];

export function approverModeLabel(mode: ApproverMode): string {
	switch (mode) {
		case 'requester':
			return 'The person it acts as';
		case 'requester-or-group':
			return 'That person or the approvers group';
		case 'group-only':
			return 'Only the approvers group';
	}
}

/** Bidirectional controls: text that reads differently from what runs. Refused outright (M25). */
const BIDI_CONTROLS = /[\u202A-\u202E\u2066-\u2069]/u;

export function hasBidiControls(text: string): boolean {
	return BIDI_CONTROLS.test(text);
}

const INVISIBLE: Record<string, string> = {
	'\u200B': 'zero-width space',
	'\u200C': 'zero-width non-joiner',
	'\u200D': 'zero-width joiner',
	'\u2060': 'word joiner',
	'\uFEFF': 'zero-width no-break space',
	'\u00A0': 'non-breaking space',
	'\u2007': 'figure space',
	'\u202F': 'narrow non-breaking space',
	'\t': 'tab',
	'\r': 'carriage return'
};

/**
 * One piece of a command as the approval card shows it (SPEC-MCP 11.2): plain text, an invisible
 * character drawn as a visible marker, or a non-ASCII character inside an otherwise ASCII word
 * (a look-alike letter), highlighted.
 */
export type CommandPiece =
	| { kind: 'text'; text: string }
	| { kind: 'marker'; label: string }
	| { kind: 'unusual'; text: string; label: string };

function codePointLabel(char: string): string {
	return `U+${(char.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, '0')}`;
}

/** The pieces of one word: a non-ASCII letter among ASCII ones is unusual. */
function wordPieces(word: string): CommandPiece[] {
	const chars = Array.from(word);
	const ascii = chars.filter((char) => /^[\x21-\x7E]$/u.test(char)).length;
	if (ascii === 0 || ascii === chars.length) {
		return [{ kind: 'text', text: word }];
	}
	return chars.map((char) =>
		/^[\x21-\x7E]$/u.test(char)
			? { kind: 'text', text: char }
			: { kind: 'unusual', text: char, label: `${codePointLabel(char)} in an otherwise plain word` }
	);
}

/** The command split into pieces with every invisible or unusual character made visible. */
export function commandPieces(command: string): CommandPiece[] {
	const pieces: CommandPiece[] = [];
	const push = (piece: CommandPiece): void => {
		const last = pieces.at(-1);
		if (piece.kind === 'text' && last?.kind === 'text') {
			pieces[pieces.length - 1] = { kind: 'text', text: last.text + piece.text };
		} else {
			pieces.push(piece);
		}
	};
	// Words are runs of anything but ordinary whitespace and the invisible characters.
	for (const part of command.split(/([\s\u200B-\u200D\u2060\uFEFF\u202A-\u202E\u2066-\u2069])/u)) {
		if (part === '') {
			continue;
		}
		const invisible = INVISIBLE[part];
		if (invisible !== undefined) {
			push({ kind: 'marker', label: invisible });
		} else if (BIDI_CONTROLS.test(part)) {
			push({ kind: 'marker', label: `direction control ${codePointLabel(part)}` });
		} else if (/^\s$/u.test(part) && part !== ' ' && part !== '\n') {
			push({ kind: 'marker', label: `space ${codePointLabel(part)}` });
		} else {
			for (const piece of wordPieces(part)) {
				push(piece);
			}
		}
	}
	return pieces;
}

/** How many invisible or unusual characters the card marks. */
export function markedCount(pieces: readonly CommandPiece[]): number {
	return pieces.filter((piece) => piece.kind !== 'text').length;
}

/**
 * Hints on the approval card (SPEC-MCP 11.1). They help a person read; they are never the
 * boundary, which is the person's approval.
 */
export function commandWarnings(command: string): string[] {
	const warnings: string[] = [];
	if (
		/\b(rm|rmdir|del|erase|mv|Remove-Item|Move-Item|Rename-Item|New-Item|Set-Content|Out-File|chmod|chown|truncate|mkfs|dd|kill|pkill|killall|taskkill|Stop-Process|shutdown|reboot|Restart-Computer|Stop-Computer|Stop-Service|Restart-Service|Set-Service|Set-ItemProperty|apt|apt-get|dnf|yum|pacman|snap|winget|choco|msiexec|useradd|userdel|passwd|net\s+user|crontab)\b/iu.test(
			command
		) ||
		/\bsystemctl\s+(stop|start|restart|reload|disable|enable|mask|kill)\b/iu.test(command) ||
		/\bsc(\.exe)?\s+(stop|start|config|delete|create)\b/iu.test(command) ||
		/\breg(\.exe)?\s+(add|delete|import)\b/iu.test(command) ||
		/(^|[^<>2&])>{1,2}\s*[^\s&|]/u.test(command)
	) {
		warnings.push('It may change files, settings or services.');
	}
	if (
		/\b(curl|wget|Invoke-WebRequest|iwr|Invoke-RestMethod|irm|DownloadString|DownloadFile|Start-BitsTransfer|bitsadmin|certutil)\b/iu.test(
			command
		)
	) {
		warnings.push('It downloads something from the network, and may run it.');
	}
	if (
		/(^|\s)-(e|ec|en|enc|enco|encod|encode|encoded|encodedc|encodedcommand)\s/iu.test(command) ||
		/base64\s+(-d|--decode)/iu.test(command) ||
		/FromBase64String/iu.test(command) ||
		/\b(iex|Invoke-Expression|eval)\b/iu.test(command) ||
		/\|\s*(sh|bash|zsh|python3?|perl|powershell|pwsh)\b/iu.test(command)
	) {
		warnings.push('It runs hidden or generated content: what runs is not all written out here.');
	}
	if (/bmuster/iu.test(command)) {
		warnings.push(
			"It touches BMuster's own agent or service. If the agent stops, the result is lost."
		);
	}
	return warnings;
}

/** One machine on the approval card: what will happen to it if approved now. */
export type ApprovalMachine = {
	id: string;
	name: string;
	plan: 'runs' | 'offline' | 'agent-too-old';
};

/** Whether the person looking at a request may decide it, and how they prove it is them. */
export type ApprovalDecide = { kind: 'yes'; signIn: SignInCheck } | { kind: 'no'; why: string };

/** A request waiting for approval, as the approval card shows it (SPEC-MCP 11.1, M25). */
export type ApprovalView = {
	runId: string;
	requestedBy: string;
	assistant: string;
	verified: boolean;
	reason: string;
	requestedIso: string;
	expiresIso: string;
	osFamily: CommandOsFamily;
	shell: CommandShell;
	command: string;
	timeoutMs: number;
	machines: ApprovalMachine[];
	decide: ApprovalDecide;
};

/** A request on the Approvals page and in the live notice (M26). */
export type ApprovalSummary = {
	runId: string;
	requestedBy: string;
	assistant: string;
	machineNames: string[];
	firstLine: string;
	requestedIso: string;
	expiresIso: string;
};

/** "mint", "mint and reception", "mint, reception and 3 more". */
export function machineNamesText(names: readonly string[]): string {
	if (names.length <= 2) {
		return names.join(' and ');
	}
	const [first = '', second = ''] = names;
	return `${first}, ${second} and ${String(names.length - 2)} more`;
}

/** The Approvals entry in the navigation: hidden for people who may not approve (M26). */
export type ApprovalsNav = { kind: 'hidden' } | { kind: 'shown'; pending: number };

/** What the console's live channel carries (`GET /api/live`, SPEC-MCP 10.3). */
export type LiveEvent =
	| { kind: 'approval-requested'; approval: ApprovalSummary; pending: number }
	| { kind: 'approval-decided'; runId: string; pending: number };

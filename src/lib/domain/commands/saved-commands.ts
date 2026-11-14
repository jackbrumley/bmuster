/**
 * Saved commands (SPEC-SAVED-COMMANDS): scripts an admin writes once, which people run in two
 * clicks and AI assistants may run without approval when every condition holds. Browser-safe:
 * the parameter types, their patterns, the labels, and how a parameter value reaches the
 * script, which is only ever as an environment variable set before the admin's script.
 */
import type { CommandOsFamily, CommandShell } from './commands.ts';

export const SAVED_COMMAND_LIMITS = {
	maxNameChars: 80,
	maxDescriptionChars: 500,
	maxScriptChars: 6000,
	maxParameters: 8,
	maxChoices: 20,
	maxLabelChars: 80,
	minNumber: -1_000_000_000,
	maxNumber: 1_000_000_000,
	/** Unattended runs per assistant grant an hour (SC20). */
	unattendedPerHour: 60
} as const;

/** The admin's honest label, shown on every run (SC14). */
export const SAVED_EFFECTS = ['reads-only', 'changes'] as const;

export type SavedEffect = (typeof SAVED_EFFECTS)[number];

export function savedEffectLabel(effect: SavedEffect): 'Reads only' | 'Changes the machine' {
	switch (effect) {
		case 'reads-only':
			return 'Reads only';
		case 'changes':
			return 'Changes the machine';
	}
}

/** The patterns a short text parameter may use (SC3): each allows only a strict character set. */
export const TEXT_PATTERNS = ['service-name', 'package-name', 'host-name', 'path', 'word'] as const;

export type TextPattern = (typeof TEXT_PATTERNS)[number];

export function textPatternRegex(pattern: TextPattern): RegExp {
	switch (pattern) {
		case 'service-name':
			return /^[A-Za-z0-9_.@-]{1,128}$/;
		case 'package-name':
			return /^[A-Za-z0-9][A-Za-z0-9_.+:-]{0,127}$/;
		case 'host-name':
			return /^[A-Za-z0-9.-]{1,253}$/;
		case 'path':
			return /^[A-Za-z0-9_.:/\\ -]{1,260}$/;
		case 'word':
			return /^[A-Za-z0-9_-]{1,64}$/;
	}
}

export function textPatternLabel(pattern: TextPattern): string {
	switch (pattern) {
		case 'service-name':
			return 'Service name';
		case 'package-name':
			return 'Package name';
		case 'host-name':
			return 'Host name or address';
		case 'path':
			return 'Path';
		case 'word':
			return 'One word';
	}
}

/** What a value of each pattern may hold, in words, for the field's hint and errors. */
export function textPatternHint(pattern: TextPattern): string {
	switch (pattern) {
		case 'service-name':
			return 'Letters, digits and _ . @ -, up to 128';
		case 'package-name':
			return 'Starts with a letter or digit; then letters, digits and _ . + : -, up to 128';
		case 'host-name':
			return 'Letters, digits, dots and -, up to 253';
		case 'path':
			return 'Letters, digits, spaces and _ . : / \\ -, up to 260';
		case 'word':
			return 'Letters, digits, _ and -, up to 64';
	}
}

/** A choice parameter's values: a strict set too, since they reach a shell (SC3). */
export const CHOICE_VALUE = /^[A-Za-z0-9_.:@/\\ +-]{1,128}$/;

/** A parameter's name, which becomes BMUSTER_PARAM_<NAME>. */
export const PARAMETER_NAME = /^[a-z][a-z0-9_]{0,31}$/;

export type SavedParameter =
	| { kind: 'number'; name: string; label: string; min: number; max: number }
	| { kind: 'choice'; name: string; label: string; choices: string[] }
	| { kind: 'text'; name: string; label: string; pattern: TextPattern };

/** One system's script; a saved command has one per system it runs on, at least one. */
export type SavedScript = { osFamily: CommandOsFamily; shell: CommandShell; script: string };

/** The values a run fills in, by parameter name. Numbers stay numbers until they become text. */
export type ParameterValues = Record<string, string | number>;

/** "BMUSTER_PARAM_SERVICE" for `service`. */
export function parameterEnvName(name: string): string {
	return `BMUSTER_PARAM_${name.toUpperCase()}`;
}

/** Why a value does not fit its parameter, or undefined when it does (SC3, SC12). */
export function parameterValueProblem(
	parameter: SavedParameter,
	value: string | number | undefined
): string | undefined {
	if (value === undefined || value === '') {
		return `Fill in ${parameter.label}.`;
	}
	switch (parameter.kind) {
		case 'number': {
			const number = typeof value === 'number' ? value : Number(value.trim());
			if (
				!Number.isInteger(number) ||
				(typeof value === 'string' && !/^-?\d+$/.test(value.trim()))
			) {
				return `${parameter.label} is a whole number.`;
			}
			return number < parameter.min || number > parameter.max
				? `${parameter.label} is ${String(parameter.min)} to ${String(parameter.max)}.`
				: undefined;
		}
		case 'choice':
			return typeof value === 'string' && parameter.choices.includes(value)
				? undefined
				: `Pick one of the choices for ${parameter.label}.`;
		case 'text':
			return typeof value === 'string' && textPatternRegex(parameter.pattern).test(value)
				? undefined
				: `${parameter.label}: ${textPatternHint(parameter.pattern)}.`;
	}
}

/** A checked value as the text the environment variable holds. */
function valueText(parameter: SavedParameter, value: string | number): string {
	return parameter.kind === 'number' ? String(Number(value)) : String(value);
}

function base64(text: string): string {
	let binary = '';
	for (const byte of new TextEncoder().encode(text)) {
		binary += String.fromCharCode(byte);
	}
	return btoa(binary);
}

/** POSIX single quotes: nothing inside is special; a quote is closed, escaped and reopened. */
function singleQuoted(text: string): string {
	return `'${text.replaceAll("'", "'\\''")}'`;
}

/** The comment that starts a prelude: `#` is a comment in sh, bash and PowerShell alike. */
export const PRELUDE_HEADING = '# BMuster: saved command parameters';

/**
 * The command signed into each ticket (SC13): a prelude that sets each value as an environment
 * variable, then the admin's script, byte for byte. Values never become script text; the
 * prelude's quoting cannot be broken (POSIX single quotes; base64 for PowerShell, which also
 * treats typographic quotes as quotes). cmd takes no parameters (SC3). The values must already
 * have been checked with `parameterValueProblem`.
 */
export function composeCommand(
	script: SavedScript,
	parameters: readonly SavedParameter[],
	values: ParameterValues
): string {
	if (parameters.length === 0) {
		return script.script;
	}
	const lines = parameters.map((parameter) => {
		const value = values[parameter.name];
		if (value === undefined) {
			throw new Error(`No value for ${parameter.name}`);
		}
		const name = parameterEnvName(parameter.name);
		const text = valueText(parameter, value);
		switch (script.shell) {
			case 'sh':
			case 'bash':
				return `export ${name}=${singleQuoted(text)}`;
			case 'powershell':
				return `$env:${name} = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${base64(text)}'))`;
			case 'cmd':
				throw new Error('cmd scripts take no parameters');
		}
	});
	return [PRELUDE_HEADING, ...lines, '', script.script].join('\n');
}

/** A saved command as the console lists it (SC1). */
export type SavedCommandSummary = {
	id: string;
	name: string;
	description: string;
	effect: SavedEffect;
	systems: CommandOsFamily[];
	enabled: boolean;
	aiUnattended: boolean;
	version: number;
};

/** A saved command in full, for its form (admins) and its run screen. */
export type SavedCommandView = SavedCommandSummary & {
	scripts: SavedScript[];
	parameters: SavedParameter[];
	machineGroupIds: string[];
	timeoutMs: number;
};

/** What a run of a saved command shows (SC14). */
export type SavedRunMark =
	| { kind: 'none' }
	| {
			kind: 'saved';
			name: string;
			version: number;
			effect: SavedEffect;
			values: { label: string; value: string }[];
			preApproved: boolean;
	  };

/** One machine a person may pick on a saved command's run screen (SC10). */
export type SavedRunMachine = { id: string; name: string; osFamily: CommandOsFamily };

/** "Service status (version 3) · Reads only". */
export function savedRunText(mark: Extract<SavedRunMark, { kind: 'saved' }>): string {
	return `${mark.name} (version ${String(mark.version)}) · ${savedEffectLabel(mark.effect)}`;
}

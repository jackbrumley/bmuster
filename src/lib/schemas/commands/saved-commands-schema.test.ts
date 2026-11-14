import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import {
	composeCommand,
	parameterValueProblem,
	PRELUDE_HEADING,
	type SavedParameter
} from '#lib/domain/commands/saved-commands.ts';
import { savedFields } from '#tests/helpers/saved-commands.ts';
import { savedCommandFieldsSchema } from './saved-commands.ts';

const first = (result: ReturnType<typeof savedCommandFieldsSchema.safeParse>) =>
	result.success ? undefined : result.error.issues[0]?.message;

describe('what a saved command holds (SPEC-SAVED-COMMANDS SC2)', () => {
	it('SC2: name, description, scripts, groups, label and time limit are checked', () => {
		expect(savedCommandFieldsSchema.safeParse(savedFields()).success).toBe(true);
		expect(first(savedCommandFieldsSchema.safeParse(savedFields({ name: ' ' })))).toBe(
			'Give it a name.'
		);
		expect(first(savedCommandFieldsSchema.safeParse(savedFields({ name: 'x'.repeat(81) })))).toBe(
			'A name is at most 80 characters.'
		);
		expect(first(savedCommandFieldsSchema.safeParse(savedFields({ description: '' })))).toBe(
			'Say what it does.'
		);
		expect(first(savedCommandFieldsSchema.safeParse(savedFields({ scripts: [] })))).toBe(
			'Write a script for at least one system.'
		);
		expect(first(savedCommandFieldsSchema.safeParse(savedFields({ machineGroupIds: [] })))).toBe(
			'Choose at least one machine group.'
		);
		expect(first(savedCommandFieldsSchema.safeParse(savedFields({ timeoutMs: 601_000 })))).toBe(
			'The time limit is at most 10 minutes.'
		);
		const script = (text: string) =>
			savedFields({ scripts: [{ osFamily: 'linux', shell: 'sh', script: text }] });
		expect(first(savedCommandFieldsSchema.safeParse(script('x'.repeat(6001))))).toBe(
			'A script is at most 6,000 characters.'
		);
		expect(first(savedCommandFieldsSchema.safeParse(script('echo \0')))).toBe(
			'A script cannot contain a NUL character.'
		);
		expect(first(savedCommandFieldsSchema.safeParse(script('echo \u202Eevil')))).toBe(
			'A script cannot contain text-direction control characters.'
		);
		expect(
			first(
				savedCommandFieldsSchema.safeParse(
					savedFields({
						scripts: [
							{ osFamily: 'linux', shell: 'sh', script: 'a' },
							{ osFamily: 'linux', shell: 'bash', script: 'b' }
						]
					})
				)
			)
		).toBe('Write one script per system.');
		expect(
			savedCommandFieldsSchema.safeParse(
				savedFields({ scripts: [{ osFamily: 'windows', shell: 'sh', script: 'x' }] })
			).success
		).toBe(false);
	});
});

describe('typed parameters (SC3)', () => {
	const number: SavedParameter = { kind: 'number', name: 'hours', label: 'Hours', min: 1, max: 72 };
	const choice: SavedParameter = {
		kind: 'choice',
		name: 'unit',
		label: 'Unit',
		choices: ['nginx', 'sshd']
	};
	const text = (pattern: Extract<SavedParameter, { kind: 'text' }>['pattern']): SavedParameter => ({
		kind: 'text',
		name: 'value',
		label: 'Value',
		pattern
	});

	it('SC3: a whole number between its min and max', () => {
		expect(parameterValueProblem(number, 24)).toBeUndefined();
		expect(parameterValueProblem(number, '72')).toBeUndefined();
		expect(parameterValueProblem(number, 0)).toBe('Hours is 1 to 72.');
		expect(parameterValueProblem(number, '1.5')).toBe('Hours is a whole number.');
		expect(parameterValueProblem(number, '1e2')).toBe('Hours is a whole number.');
		expect(parameterValueProblem(number, '24; reboot')).toBe('Hours is a whole number.');
		expect(parameterValueProblem(number, undefined)).toBe('Fill in Hours.');
	});

	it('SC3: a choice from its fixed list, exactly', () => {
		expect(parameterValueProblem(choice, 'nginx')).toBeUndefined();
		expect(parameterValueProblem(choice, 'NGINX')).toBe('Pick one of the choices for Unit.');
		expect(parameterValueProblem(choice, 'nginx; reboot')).toBe(
			'Pick one of the choices for Unit.'
		);
	});

	it('SC3: short text matching its preset pattern; nothing a shell treats specially', () => {
		const good: [Extract<SavedParameter, { kind: 'text' }>['pattern'], string][] = [
			['service-name', 'systemd-resolved.service'],
			['service-name', 'getty@tty1'],
			['package-name', 'libstdc++6:amd64'],
			['host-name', 'web-1.example.com'],
			['host-name', '192.0.2.10'],
			['path', 'C:\\Program Files\\App'],
			['path', '/var/log/nginx'],
			['word', 'error_log']
		];
		for (const [pattern, value] of good) {
			expect(parameterValueProblem(text(pattern), value), `${pattern} ${value}`).toBeUndefined();
		}
		const hostile = ["a'b", 'a"b', 'a$b', 'a`b', 'a;b', 'a|b', 'a&b', 'a\nb', 'a%b', 'a(b)', '‘a’'];
		for (const pattern of ['service-name', 'package-name', 'host-name', 'path', 'word'] as const) {
			for (const value of hostile) {
				expect(parameterValueProblem(text(pattern), value), `${pattern} ${value}`).toBeDefined();
			}
		}
	});

	it('SC3: parameters are named once, numbers have min ≤ max, choices are strict; no cmd with parameters', () => {
		const withParameters = (parameters: SavedParameter[]) =>
			first(savedCommandFieldsSchema.safeParse(savedFields({ parameters })));
		expect(withParameters([number, number])).toBe('Two parameters have the same name.');
		expect(withParameters([{ ...number, min: 10, max: 1 }])).toBe(
			'Hours: the smallest is more than the largest.'
		);
		expect(withParameters([{ ...choice, choices: ['a;b'] }])).toContain('A choice is letters');
		expect(withParameters([{ ...choice, choices: [] }])).toBe('Give at least one choice.');
		expect(withParameters([{ ...number, name: 'Hours' }])).toContain('A parameter name is');
		expect(
			withParameters(
				Array.from({ length: 9 }, (_, index) => ({ ...number, name: `p${String(index)}` }))
			)
		).toBe('At most 8 parameters.');
		expect(
			first(
				savedCommandFieldsSchema.safeParse(
					savedFields({
						parameters: [number],
						scripts: [{ osFamily: 'windows', shell: 'cmd', script: 'echo %BMUSTER_PARAM_HOURS%' }]
					})
				)
			)
		).toBe('A Windows script with parameters must be PowerShell: cmd cannot read them safely.');
		expect(
			savedCommandFieldsSchema.safeParse(
				savedFields({
					parameters: [],
					scripts: [{ osFamily: 'windows', shell: 'cmd', script: 'ipconfig /all' }]
				})
			).success
		).toBe(true);
	});
});

describe('values only through the environment (SC13)', () => {
	const parameters: SavedParameter[] = [
		{ kind: 'text', name: 'path', label: 'Path', pattern: 'path' },
		{ kind: 'number', name: 'hours', label: 'Hours', min: 1, max: 72 }
	];
	const values = { path: "/srv/it's here", hours: 24 };

	it('SC13: sh and bash: a prelude of single-quoted exports, then the script byte for byte', () => {
		const script = 'ls -l "$BMUSTER_PARAM_PATH"; echo "$BMUSTER_PARAM_HOURS"';
		const command = composeCommand({ osFamily: 'linux', shell: 'sh', script }, parameters, values);
		expect(command).toBe(
			[
				PRELUDE_HEADING,
				"export BMUSTER_PARAM_PATH='/srv/it'\\''s here'",
				"export BMUSTER_PARAM_HOURS='24'",
				'',
				script
			].join('\n')
		);
		// Run for real: the shell sees the exact values in the environment, and nothing else ran.
		const printed = execFileSync('sh', [
			'-c',
			composeCommand(
				{
					osFamily: 'linux',
					shell: 'sh',
					script: 'printf "%s|%s" "$BMUSTER_PARAM_PATH" "$BMUSTER_PARAM_HOURS"'
				},
				parameters,
				{ path: '$(echo pwned)`id`;\'"', hours: 3 }
			)
		]).toString();
		expect(printed).toBe('$(echo pwned)`id`;\'"|3');
	});

	it('SC13: PowerShell: each value from base64, so no quote of any kind can end it', () => {
		const script = 'Get-ChildItem -LiteralPath $env:BMUSTER_PARAM_PATH';
		const command = composeCommand(
			{ osFamily: 'windows', shell: 'powershell', script },
			parameters,
			{ path: 'C:\\Users\\‘quoted’', hours: 1 }
		);
		const [heading, path, hours, blank, ...rest] = command.split('\n');
		expect(heading).toBe(PRELUDE_HEADING);
		expect(path).toBe(
			`$env:BMUSTER_PARAM_PATH = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${Buffer.from('C:\\Users\\‘quoted’').toString('base64')}'))`
		);
		expect(path).toMatch(/FromBase64String\('[A-Za-z0-9+/=]+'\)\)$/);
		expect(hours).toContain(`'${Buffer.from('1').toString('base64')}'`);
		expect(blank).toBe('');
		expect(rest.join('\n')).toBe(script);
	});

	it('SC13: a command without parameters is the script alone', () => {
		expect(
			composeCommand({ osFamily: 'windows', shell: 'cmd', script: 'ipconfig /all' }, [], {})
		).toBe('ipconfig /all');
	});
});

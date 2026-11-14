import { describe, expect, it } from 'vitest';
import { COMMAND_LIMITS } from '#lib/domain/commands/commands.ts';
import {
	hideReport,
	newNonce,
	readReport,
	WRAPPED_COMMAND_MAX_CHARS,
	wrapCommand,
	wrapPowerShell,
	type Wrapped
} from './command-wrapper.ts';

/**
 * The observe-only wrapper (SPEC-COMMANDS C25, C26): a fixed template around the command's
 * base64, and the report read back from the end of stderr.
 */

const NONCE = '0123456789abcdef0123456789abcdef';

/** The command a wrapped ticket carries, decoded the way the wrapper decodes it. */
function embedded(wrapped: string): string {
	const found = /FromBase64String\('([A-Za-z0-9+/=]*)'\)/.exec(wrapped);
	if (found === null) throw new Error('no base64 in the wrapper');
	return Buffer.from(found[1] ?? '', 'base64').toString('utf8');
}

/** The wrapper with the command's base64 taken out: what must never change between commands. */
function template(wrapped: string): string {
	return wrapped.replace(/FromBase64String\('[A-Za-z0-9+/=]*'\)/, "FromBase64String('…')");
}

const AWKWARD = [
	`Write-Output "double" 'single' "it's" '"'`,
	'$x = $(Get-Date); "$(1 + 2) and ${env:PATH}"',
	'Write-Output `t`n `"escaped`" ```',
	`$here = @'\nliteral $(not run) "quoted"\n'@\n$there = @"\nexpanded $(1+1)\n"@`,
	'Write-Output "Größe: 5 °C · 東京 · 🎉 · “typographic” ‘quotes’ – dash"',
	"'); Remove-Item C:\\ -Recurse; ('",
	"Write-Output 'end' # comment with ' and \" and `",
	'\r\nlines\r\nwith CRLF\r\n',
	`BMUSTER-PS-1 ${NONCE} errors=0`
];

const PS: Wrapped = wrapCommand('powershell', 'Get-Date', NONCE);

describe('the wrapper (SPEC-COMMANDS C25)', () => {
	it('C25: quotes, $(…), backticks, here-strings and non-ASCII survive byte for byte', () => {
		for (const command of AWKWARD) {
			const decoded = embedded(wrapPowerShell(command, NONCE));
			expect(decoded).toBe(command);
			expect(Buffer.from(decoded, 'utf8').equals(Buffer.from(command, 'utf8'))).toBe(true);
		}
	});

	it('C25: the command is only ever base64: the template is the same for every command', () => {
		const templates = new Set(AWKWARD.map((command) => template(wrapPowerShell(command, NONCE))));
		expect(templates.size).toBe(1);
		for (const command of AWKWARD) {
			const wrapped = wrapPowerShell(command, NONCE);
			// Nothing of the command appears as text, and nothing Windows would have to escape.
			expect(wrapped).not.toContain('Remove-Item');
			expect(wrapped).not.toContain('"');
			expect(wrapped).not.toContain('\\');
			expect(wrapped).not.toContain('\n');
		}
	});

	it('C25: the template, as reviewed', () => {
		expect(template(wrapPowerShell('Get-Date', NONCE)).split('; ')).toEqual([
			`$null = Register-EngineEvent -SourceIdentifier PowerShell.Exiting -Action { if ($global:BMusterReported -ne $true) { [Console]::Error.WriteLine([string][char]10 + 'BMUSTER-PS-1 ${NONCE} errors=' + $global:Error.Count) } }`,
			'$global:BMusterReported = $false',
			'$global:BMusterOk = $true',
			"$BMusterText = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('…'))",
			'$BMusterAst = [Management.Automation.Language.Parser]::ParseInput($BMusterText, [ref]$null, [ref]$null)',
			"if ($BMusterAst.EndBlock.Unnamed -and $null -eq $BMusterAst.BeginBlock -and $null -eq $BMusterAst.ProcessBlock -and $null -eq $BMusterAst.DynamicParamBlock) { $BMusterText = $BMusterText + [char]10 + [char]10 + '$global:BMusterOk = $?' }",
			'$BMusterScript = [ScriptBlock]::Create($BMusterText)',
			'if ($null -eq $BMusterScript) { exit 1 }',
			'. $BMusterScript',
			'$global:BMusterReported = $true',
			`[Console]::Error.WriteLine([string][char]10 + 'BMUSTER-PS-1 ${NONCE} errors=' + $global:Error.Count)`,
			'if ($global:BMusterOk -ne $true) { exit 1 }'
		]);
	});

	it('C25: it sets no preference and changes no behaviour', () => {
		expect(wrapPowerShell('Get-Date', NONCE)).not.toMatch(
			/Preference|Set-StrictMode|-ErrorAction|\btrap\b|\btry\b|\bcatch\b/i
		);
	});

	it('C25: only a hex nonce reaches the template', () => {
		expect(() => wrapPowerShell('Get-Date', "x' + (Remove-Item C:\\) + '")).toThrow();
		expect(newNonce()).toMatch(/^[0-9a-f]{32}$/);
		expect(newNonce()).not.toBe(newNonce());
	});

	it('C25: sh, bash and cmd run as written', () => {
		for (const shell of ['sh', 'bash', 'cmd'] as const) {
			expect(wrapCommand(shell, 'false; echo "$(id)"', NONCE)).toEqual({
				kind: 'none',
				command: 'false; echo "$(id)"'
			});
		}
		expect(PS).toMatchObject({ kind: 'ps-1', nonce: NONCE });
	});

	it('C30: the longest PowerShell command still fits Windows’s command line', () => {
		const widest = `${'語'.repeat(Math.floor(COMMAND_LIMITS.maxPowerShellBytes / 3))}xx`;
		expect(Buffer.byteLength(widest)).toBe(COMMAND_LIMITS.maxPowerShellBytes);
		expect(wrapPowerShell(widest, NONCE).length).toBeLessThanOrEqual(WRAPPED_COMMAND_MAX_CHARS);
		// 32,767 less the program path, switches and quotes (spawn.rs), with room to spare.
		const program =
			'"C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -NoLogo -NoProfile -NonInteractive -Command ""';
		expect(WRAPPED_COMMAND_MAX_CHARS + program.length).toBeLessThan(32_767 - 500);
	});
});

const report = (count: number, newline = '\r\n') =>
	`\nBMUSTER-PS-1 ${NONCE} errors=${String(count)}${newline}`;

describe('reading the report (SPEC-COMMANDS C26)', () => {
	it('C26: the last line is read and taken off, leaving the command’s own stderr exactly', () => {
		for (const own of ['', 'Get-CimInstance : Invalid class\r\n', 'no newline at the end']) {
			expect(readReport(PS, Buffer.from(own + report(3)))).toEqual({
				stderr: Buffer.from(own),
				errorsReported: 3
			});
		}
		expect(readReport(PS, Buffer.from(report(0, '\n')))).toEqual({
			stderr: Buffer.from(''),
			errorsReported: 0
		});
	});

	it('C26: a marker the command prints itself stays as text; only the last line counts', () => {
		const fake = `BMUSTER-PS-1 ${NONCE} errors=0\r\n`;
		expect(readReport(PS, Buffer.from(`${fake}oops\r\n${report(2)}`))).toEqual({
			stderr: Buffer.from(`${fake}oops\r\n`),
			errorsReported: 2
		});
		// Another run's nonce, or a marker that is not last, is never trusted.
		const other = `\nBMUSTER-PS-1 ${'f'.repeat(32)} errors=0\r\n`;
		expect(readReport(PS, Buffer.from(other))).toEqual({
			stderr: Buffer.from(other),
			errorsReported: null
		});
		const notLast = `${report(0)}more\r\n`;
		expect(readReport(PS, Buffer.from(notLast))).toEqual({
			stderr: Buffer.from(notLast),
			errorsReported: null
		});
		const malformed = `\nBMUSTER-PS-1 ${NONCE} errors=-1\r\n`;
		expect(readReport(PS, Buffer.from(malformed)).errorsReported).toBeNull();
	});

	it('C26: no report (cut off, killed) is not reported, never 0', () => {
		expect(readReport(PS, Buffer.from('half way\r\n'))).toEqual({
			stderr: Buffer.from('half way\r\n'),
			errorsReported: null
		});
	});

	it('C26: unwrapped shells keep stderr untouched, a marker included', () => {
		const wrapped = wrapCommand('bash', 'x', NONCE);
		const text = Buffer.from(report(1));
		expect(readReport(wrapped, text)).toEqual({ stderr: text, errorsReported: null });
		expect(hideReport(wrapped, report(1))).toBe(report(1));
	});

	it('C26: live output hides the report and any last line that may still become it', () => {
		const own = 'Invalid class\r\n';
		const full = own + report(4);
		for (let end = 0; end <= full.length; end += 1) {
			// The text so far is always the start of the text the result keeps.
			expect(own.startsWith(hideReport(PS, full.slice(0, end)))).toBe(true);
		}
		expect(hideReport(PS, full)).toBe(own);
		expect(hideReport(PS, own)).toBe('Invalid class\r');
		expect(hideReport(PS, `${own}not the marker`)).toBe(`${own}not the marker`);
	});
});

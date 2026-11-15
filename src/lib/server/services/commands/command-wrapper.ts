import { randomBytes } from 'node:crypto';
import type { CommandShell } from '#lib/domain/commands/commands.ts';

/**
 * The observe-only wrapper (SPEC-COMMANDS C25, C26). PowerShell prints most errors and still
 * exits 0, so a PowerShell machine's ticket names this fixed wrapper in place of the command.
 * The command is in it only as base64 of its UTF-8 text, never as script text. The wrapper
 * decodes it, dot-sources it (the same scope, output untouched, no preference set, its own
 * `exit` kept), then writes one last line to stderr: how many errors PowerShell recorded.
 *
 * Exit codes follow `powershell -Command` (about_PowerShell_exe): the command's `exit N` ends
 * the process with N; a script-terminating error gives 1; otherwise 1 when its last statement
 * failed, else 0. The status line appended after the command (`$?` of its last statement) is
 * what lets the wrapper give that 1, because `$?` after a dot-sourced block does not reflect
 * its last statement. A script whose top level is named blocks (`begin`, `process`, `end`)
 * cannot take a line after it, so it runs as it is, exiting 0 unless it throws or calls `exit`.
 *
 * The report is a line in a fixed format with a nonce made for this one machine's run, after
 * a newline of its own, as the very last bytes of stderr. The server trusts only that: a
 * marker printed by the command anywhere else stays in the output as text. A command can read
 * its own command line and so could print a convincing marker last itself; that only lets it
 * misstate its own error count, which it could hide anyway (`$Error.Clear()`), and gains it
 * nothing it does not already have as root or SYSTEM.
 *
 * sh, bash and cmd run as written (C29): their exit codes are reliable.
 */

const POWERSHELL_WRAPPER = 'ps-1';

/**
 * The longest a wrapped command may be. Windows's command line holds 32,767 characters; the
 * rest is for the agent's `powershell.exe` path, its switches and the quotes around the
 * command (agent/crates/agent/src/exec/spawn.rs).
 */
export const WRAPPED_COMMAND_MAX_CHARS = 32_000;

const NONCE = /^[0-9a-f]{32}$/;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/** A one-off nonce for one machine's run. */
export function newNonce(): string {
	return randomBytes(16).toString('hex');
}

function reportHead(nonce: string): string {
	return `BMUSTER-PS-1 ${nonce} errors=`;
}

/** The ticket's command for a PowerShell command: the fixed template around its base64. */
export function wrapPowerShell(command: string, nonce: string): string {
	const encoded = Buffer.from(command, 'utf8').toString('base64');
	// Both are checked so nothing but base64 and hex can ever reach the template.
	if (!NONCE.test(nonce) || !BASE64.test(encoded)) {
		throw new Error('The wrapper takes a hex nonce and base64 only');
	}
	const report = `[Console]::Error.WriteLine([string][char]10 + '${reportHead(nonce)}' + $global:Error.Count)`;
	return [
		`$null = Register-EngineEvent -SourceIdentifier PowerShell.Exiting -Action { if ($global:BMusterReported -ne $true) { ${report} } }`,
		'$global:BMusterReported = $false',
		'$global:BMusterOk = $true',
		`$BMusterText = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}'))`,
		'$BMusterAst = [Management.Automation.Language.Parser]::ParseInput($BMusterText, [ref]$null, [ref]$null)',
		"if ($BMusterAst.EndBlock.Unnamed -and $null -eq $BMusterAst.BeginBlock -and $null -eq $BMusterAst.ProcessBlock -and $null -eq $BMusterAst.DynamicParamBlock) { $BMusterText = $BMusterText + [char]10 + [char]10 + '$global:BMusterOk = $?' }",
		'$BMusterScript = [ScriptBlock]::Create($BMusterText)',
		'if ($null -eq $BMusterScript) { exit 1 }',
		'. $BMusterScript',
		'$global:BMusterReported = $true',
		report,
		'if ($global:BMusterOk -ne $true) { exit 1 }'
	].join('; ');
}

/** What runs on the machine for this command, and how its report is read back. */
export type Wrapped =
	| { kind: 'none'; command: string }
	| { kind: typeof POWERSHELL_WRAPPER; command: string; nonce: string };

export function wrapCommand(shell: CommandShell, command: string, nonce: string): Wrapped {
	switch (shell) {
		case 'powershell':
			return { kind: POWERSHELL_WRAPPER, command: wrapPowerShell(command, nonce), nonce };
		case 'sh':
		case 'bash':
		case 'cmd':
			return { kind: 'none', command };
	}
}

/** The trusted report: a newline, the line with this run's nonce, a count, then the end. */
function reportPattern(nonce: string): RegExp {
	return new RegExp(`\\n${reportHead(nonce)}(\\d{1,9})\\r?\\n$`);
}

/** The bytes looked at for the report: its line is under 100 bytes. */
const TAIL_BYTES = 128;

/**
 * The wrapper's report read from the end of stderr, and stderr without it. Null when the last
 * line is not the report (the output was cut off, or the process killed before it wrote it).
 */
export function readReport(
	wrapped: Wrapped,
	stderr: Buffer
): { stderr: Buffer; errorsReported: number | null } {
	if (wrapped.kind === 'none') {
		return { stderr, errorsReported: null };
	}
	const start = Math.max(0, stderr.byteLength - TAIL_BYTES);
	// The report is ASCII, so latin1 keeps one character per byte and the offsets agree.
	const tail = stderr.subarray(start).toString('latin1');
	const found = reportPattern(wrapped.nonce).exec(tail);
	if (found === null) {
		return { stderr, errorsReported: null };
	}
	return {
		stderr: stderr.subarray(0, start + found.index),
		errorsReported: Number(found[1])
	};
}

/**
 * Stderr so far, for the live output (C22): without the report, and without a last line that
 * may still become it, so the text so far is always the start of the text the result keeps.
 */
export function hideReport(wrapped: Wrapped, stderr: string): string {
	if (wrapped.kind === 'none') {
		return stderr;
	}
	const head = reportHead(wrapped.nonce);
	const cut = stderr.lastIndexOf('\n');
	if (cut === -1) {
		return stderr;
	}
	const done = reportPattern(wrapped.nonce).exec(stderr);
	if (done !== null) {
		return stderr.slice(0, done.index);
	}
	const last = stderr.slice(cut + 1);
	const mayBecome =
		head.startsWith(last) || (last.startsWith(head) && /^\d*\r?$/.test(last.slice(head.length)));
	return mayBecome ? stderr.slice(0, cut) : stderr;
}

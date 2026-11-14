import { describe, expect, it } from 'vitest';
import { COMMAND_LIMITS } from '#lib/domain/commands/commands.ts';
import { commandScriptSchema, startRunRequestSchema } from './commands.ts';

const MACHINE = '11111111-1111-4111-8111-111111111111';

function start(overrides: Record<string, unknown>) {
	return startRunRequestSchema.safeParse({
		machineIds: [MACHINE],
		scripts: [{ osFamily: 'linux', shell: 'sh', command: 'uptime' }],
		timeoutMs: 60_000,
		confirmCount: 1,
		recheck: { kind: 'none' },
		rerunOf: null,
		...overrides
	});
}

describe('command limits (SPEC-COMMANDS C7)', () => {
	it('C7: a command is 1 to 8,000 characters with no NUL', () => {
		const script = (command: string) =>
			commandScriptSchema.safeParse({ osFamily: 'linux', shell: 'bash', command });
		expect(script('systemctl restart cups').success).toBe(true);
		expect(script('x'.repeat(COMMAND_LIMITS.maxCommandChars)).success).toBe(true);
		expect(script('x'.repeat(COMMAND_LIMITS.maxCommandChars + 1)).success).toBe(false);
		expect(script('').success).toBe(false);
		expect(script('   ').success).toBe(false);
		const nul = script('echo a\0b');
		expect(nul.success).toBe(false);
		expect(nul.error?.issues[0]?.message).toBe('A command cannot contain a NUL character.');
	});

	it('C7: each system offers only its own shells', () => {
		const shell = (osFamily: string, name: string) =>
			commandScriptSchema.safeParse({ osFamily, shell: name, command: 'whoami' }).success;
		expect(shell('windows', 'powershell')).toBe(true);
		expect(shell('windows', 'cmd')).toBe(true);
		expect(shell('windows', 'bash')).toBe(false);
		expect(shell('linux', 'sh')).toBe(true);
		expect(shell('linux', 'bash')).toBe(true);
		expect(shell('linux', 'powershell')).toBe(false);
		expect(shell('macos', 'zsh')).toBe(false);
	});

	it('C7: the time limit is 5 s to 10 min', () => {
		expect(start({ timeoutMs: 5_000 }).success).toBe(true);
		expect(start({ timeoutMs: 600_000 }).success).toBe(true);
		expect(start({ timeoutMs: 4_999 }).success).toBe(false);
		expect(start({ timeoutMs: 600_001 }).success).toBe(false);
		expect(start({ timeoutMs: 1.5 }).success).toBe(false);
		expect(COMMAND_LIMITS.defaultTimeoutMs).toBe(60_000);
	});

	it('C7: output is capped at 1 MB per stream per machine', () => {
		expect(COMMAND_LIMITS.maxOutputBytesPerStream).toBe(1024 * 1024);
	});

	it('C6, C7: one command per system, at least one machine, no machine twice', () => {
		expect(start({ machineIds: [] }).success).toBe(false);
		expect(start({ machineIds: [MACHINE, MACHINE], confirmCount: 2 }).success).toBe(false);
		expect(start({ machineIds: ['not-a-uuid'] }).success).toBe(false);
		expect(start({ scripts: [] }).success).toBe(false);
		expect(
			start({
				scripts: [
					{ osFamily: 'linux', shell: 'sh', command: 'uptime' },
					{ osFamily: 'linux', shell: 'bash', command: 'uptime' }
				]
			}).success
		).toBe(false);
		expect(
			start({
				scripts: [
					{ osFamily: 'linux', shell: 'sh', command: 'uptime' },
					{ osFamily: 'windows', shell: 'cmd', command: 'ver' }
				]
			}).success
		).toBe(true);
	});
});

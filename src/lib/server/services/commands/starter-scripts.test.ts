import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { savedCommandFieldsSchema } from '#lib/schemas/commands/saved-commands.ts';
import { testDatabase } from '#tests/helpers/fake-agent.ts';
import { allSavedCommands } from './saved-commands.ts';

/**
 * SPEC-SAVED-COMMANDS SC8: the starter set the migration adds is valid as an admin would save
 * it, and every Linux script is sound POSIX sh. (The PowerShell scripts need a Windows machine:
 * they are on the real-machine test list.)
 */
describe('the starter set’s scripts (SC8)', () => {
	it('SC8: each starter passes the saved command schema; each Linux script parses with sh -n', () => {
		const starters = allSavedCommands(testDatabase());
		expect(starters).toHaveLength(8);
		for (const command of starters) {
			expect(
				savedCommandFieldsSchema.safeParse({
					name: command.name,
					description: command.description,
					scripts: command.scripts,
					machineGroupIds: command.machineGroupIds,
					parameters: command.parameters,
					effect: command.effect,
					enabled: command.enabled,
					aiUnattended: command.aiUnattended,
					timeoutMs: command.timeoutMs
				}).success,
				command.name
			).toBe(true);
			const linux = command.scripts.find((script) => script.osFamily === 'linux');
			expect(linux?.shell, command.name).toBe('sh');
			expect(() => execFileSync('sh', ['-n', '-c', linux?.script ?? 'exit 1'])).not.toThrow();
			// Parameters are read only from the environment, never written into the script.
			for (const parameter of command.parameters) {
				expect(linux?.script).toContain(`$BMUSTER_PARAM_${parameter.name.toUpperCase()}`);
				expect(command.scripts.find((script) => script.osFamily === 'windows')?.script).toContain(
					`$env:BMUSTER_PARAM_${parameter.name.toUpperCase()}`
				);
			}
		}
	});
});

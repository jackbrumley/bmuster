import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { SavedCommandView } from '#lib/domain/commands/saved-commands.ts';
import { savedCommandFieldsSchema } from '#lib/schemas/commands/saved-commands.ts';
import { testDatabase } from '#tests/helpers/fake-agent.ts';
import { allSavedCommands } from './saved-commands.ts';

/**
 * SPEC-SAVED-COMMANDS SC8, SC27–SC29: the starter set the migrations add is valid as an admin
 * would save it, every Linux script is sound POSIX sh and fails when a step fails, and every
 * PowerShell script fails loudly. There is no PowerShell on the Linux machines these tests run
 * on, so the PowerShell scripts are checked by their text; they are on the real-machine list.
 */

const starters = allSavedCommands(testDatabase());

function scriptFor(command: SavedCommandView, osFamily: 'windows' | 'linux'): string {
	const script = command.scripts.find((entry) => entry.osFamily === osFamily);
	if (script === undefined) {
		throw new Error(`${command.name} has no ${osFamily} script`);
	}
	return script.script;
}

function starter(name: string): SavedCommandView {
	const command = starters.find((entry) => entry.name === name);
	if (command === undefined) {
		throw new Error(`No starter called ${name}`);
	}
	return command;
}

/** The first lines of every starter's PowerShell script (SC27). */
const POWERSHELL_HEAD = "$ErrorActionPreference = 'Stop'\ntry {\n";

/** The last lines, so that every error, terminating or not, ends the run with exit code 1 (SC27). */
const POWERSHELL_TAIL =
	'\n} catch {\n  [Console]::Error.WriteLine("Failed: $($_.Exception.Message)")\n  exit 1\n}';

/** Commands that go through WMI or CIM, which a damaged repository breaks ("Invalid class"). */
const WMI_OR_CIM = /Get-CimInstance|Get-WmiObject|Win32_|Get-NetIPConfiguration|\[wmi/i;

describe('the starter set’s scripts (SC8)', () => {
	it('SC8: each starter passes the saved command schema; each Linux script parses with sh -n', () => {
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

describe('PowerShell starters fail loudly (SC27, SC28)', () => {
	it('SC27: each PowerShell starter stops on any error and exits 1 with the reason', () => {
		for (const command of starters) {
			const windows = command.scripts.find((script) => script.osFamily === 'windows');
			expect(windows?.shell, command.name).toBe('powershell');
			const script = scriptFor(command, 'windows');
			expect(script.startsWith(POWERSHELL_HEAD), command.name).toBe(true);
			expect(script.endsWith(POWERSHELL_TAIL), command.name).toBe(true);
			// Nothing between the head and the tail leaves the try block early.
			const body = script.slice(POWERSHELL_HEAD.length, -POWERSHELL_TAIL.length);
			expect(body, command.name).not.toMatch(/^\S/m);
			expect(body, command.name).not.toMatch(/\bexit\b/);
			// Errors are not hidden, except a broken uninstall entry while listing software.
			if (command.name !== 'Installed software') {
				expect(body, command.name).not.toContain('SilentlyContinue');
			}
		}
	});

	it('SC28: Uptime and last boot uses no WMI or CIM; nor does any other starter', () => {
		const uptime = scriptFor(starter('Uptime and last boot'), 'windows');
		expect(uptime).not.toMatch(/Get-CimInstance|Get-WmiObject|Win32_/);
		expect(uptime).toContain('[Environment]::TickCount64');
		expect(uptime).toContain("ProviderName = 'Microsoft-Windows-Kernel-General'; Id = 12");
		for (const command of starters) {
			expect(scriptFor(command, 'windows'), command.name).not.toMatch(WMI_OR_CIM);
		}
	});
});

describe('Linux starters fail when a step fails (SC29)', () => {
	const folders: string[] = [];
	afterEach(() => {
		for (const folder of folders.splice(0)) {
			rmSync(folder, { recursive: true, force: true });
		}
	});

	/** Runs a starter's Linux script with the named programs replaced by ones that exit `code`. */
	function runWith(name: string, stubs: Record<string, number>): number | null {
		const folder = mkdtempSync(join(tmpdir(), 'bmuster-starter-'));
		folders.push(folder);
		for (const [program, code] of Object.entries(stubs)) {
			const path = join(folder, program);
			writeFileSync(path, `#!/bin/sh\necho "${program} stub"\nexit ${String(code)}\n`);
			chmodSync(path, 0o755);
		}
		const result = spawnSync('sh', ['-c', scriptFor(starter(name), 'linux')], {
			env: {
				PATH: `${folder}:/usr/bin:/bin`,
				BMUSTER_PARAM_HOURS: '2',
				BMUSTER_PARAM_SERVICE: 'x'
			},
			encoding: 'utf8',
			timeout: 10_000
		});
		return result.status;
	}

	it('SC29: a failing step ends each Linux starter with a non-zero exit', () => {
		const failing: [string, Record<string, number>][] = [
			['Check for updates', { dnf: 1 }],
			['Disk space', { df: 1 }],
			['Uptime and last boot', { uptime: 1, who: 1 }],
			['Top processes', { ps: 1 }],
			['Service status', { systemctl: 4 }],
			['Recent system errors', { journalctl: 1 }],
			['Network settings', { ip: 1 }],
			['Installed software', { dnf: 0, rpm: 1 }]
		];
		expect(failing.map(([name]) => name).toSorted()).toEqual(
			starters.map((command) => command.name).toSorted()
		);
		for (const [name, stubs] of failing) {
			expect(runWith(name, stubs), name).not.toBe(0);
		}
	});

	it('SC29: Check for updates still treats dnf’s 100 (updates waiting) as success', () => {
		expect(runWith('Check for updates', { dnf: 100 })).toBe(0);
	});

	it('SC29: the stricter scripts still succeed when every step does', () => {
		expect(runWith('Uptime and last boot', { uptime: 0, cut: 0 })).toBe(0);
		expect(runWith('Top processes', { ps: 0 })).toBe(0);
		expect(runWith('Network settings', { ip: 0, resolvectl: 0 })).toBe(0);
		expect(runWith('Installed software', { dnf: 0, rpm: 0 })).toBe(0);
	});
});

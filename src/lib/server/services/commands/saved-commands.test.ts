import { afterEach, describe, expect, it } from 'vitest';
import type { SavedRunRequest } from '#lib/schemas/commands/saved-commands.ts';
import { grantAccess } from '#tests/helpers/access.ts';
import {
	connect,
	disconnectAgents,
	MINUTE,
	setUpAssistantRuns
} from '#tests/helpers/assistant-runs.ts';
import { PASSWORD } from '#tests/helpers/people.ts';
import {
	ALL_MACHINES,
	LINUX_SCRIPT,
	savedFields,
	WINDOWS_SCRIPT
} from '#tests/helpers/saved-commands.ts';
import { listAudit } from '../audit/audit.ts';
import { findRun, scriptsOf } from './command-runs.ts';
import { runViewFor } from './run-views.ts';
import { createSavedCommand, editSavedCommand, removeSavedCommand } from './saved-command-admin.ts';
import {
	planSavedRun,
	savedCommandsFor,
	savedRunMachines,
	startSavedRun
} from './saved-command-runs.ts';
import { allSavedCommands, findSavedCommand } from './saved-commands.ts';

afterEach(disconnectAgents);

const NO_RECHECK = { kind: 'none' } as const;

function runRequest(machineIds: string[], extra: Partial<SavedRunRequest> = {}): SavedRunRequest {
	return {
		version: 1,
		machineIds,
		values: { mount: '/var' },
		confirmCount: machineIds.length,
		recheck: NO_RECHECK,
		...extra
	};
}

/** Ada writes a saved command through the admin service, as the console would. */
async function written(
	setup: Awaited<ReturnType<typeof setUpAssistantRuns>>,
	fields = savedFields()
): Promise<string> {
	const change = await createSavedCommand(setup.consoleAs('admin'), {
		command: fields,
		recheck: NO_RECHECK
	});
	if (change.kind !== 'written') throw new Error(change.message);
	return change.id;
}

describe('the starter set (SPEC-SAVED-COMMANDS SC8)', () => {
	it('SC8: eight read-only commands on All machines, all switched off with AI off, Windows and Linux', async () => {
		const { database } = await setUpAssistantRuns();
		const starters = allSavedCommands(database);
		expect(starters.map((command) => command.name)).toEqual([
			'Check for updates',
			'Disk space',
			'Installed software',
			'Network settings',
			'Recent system errors',
			'Service status',
			'Top processes',
			'Uptime and last boot'
		]);
		for (const command of starters) {
			expect(command, command.name).toMatchObject({
				enabled: false,
				aiUnattended: false,
				effect: 'reads-only',
				machineGroupIds: [ALL_MACHINES],
				version: 1,
				systems: ['windows', 'linux']
			});
			expect(command.scripts.map((script) => script.shell)).toEqual(['powershell', 'sh']);
		}
		expect(starters.find((command) => command.name === 'Service status')?.parameters).toEqual([
			{ kind: 'text', name: 'service', label: 'Service', pattern: 'service-name' }
		]);
		expect(starters.find((command) => command.name === 'Recent system errors')?.parameters).toEqual(
			[{ kind: 'number', name: 'hours', label: 'Hours', min: 1, max: 72 }]
		);
		const updates = starters.find((command) => command.name === 'Check for updates');
		const linux = updates?.scripts.find((script) => script.osFamily === 'linux')?.script ?? '';
		for (const manager of ['dnf', 'apt', 'zypper']) {
			expect(linux).toContain(manager);
		}
		expect(linux).not.toMatch(/\b(install|upgrade -y|dist-upgrade)\b/);
	});

	it('SC8: switched off, the starter set is offered to nobody but admins', async () => {
		const { database, people } = await setUpAssistantRuns();
		expect(savedCommandsFor(database, people.pat)).toEqual([]);
		expect(savedCommandsFor(database, people.admin)).toHaveLength(8);
	});
});

describe('writing saved commands (SC1, SC4, SC5, SC7)', () => {
	it('SC4: members are refused; admins need a recent sign-in', async () => {
		const setup = await setUpAssistantRuns();
		expect(
			await createSavedCommand(setup.consoleAs('pat'), {
				command: savedFields(),
				recheck: NO_RECHECK
			})
		).toEqual({ kind: 'refused', status: 403, message: 'Only admins write saved commands.' });
		setup.clock.now += 11 * MINUTE;
		expect(
			await createSavedCommand(setup.consoleAs('admin'), {
				command: savedFields(),
				recheck: NO_RECHECK
			})
		).toMatchObject({ kind: 'refused', status: 403, message: expect.stringContaining('password') as unknown });
		const created = await createSavedCommand(setup.consoleAs('admin'), {
			command: savedFields(),
			recheck: { kind: 'password', password: PASSWORD }
		});
		expect(created).toMatchObject({ kind: 'written', version: 1 });
		const id = created.kind === 'written' ? created.id : '';
		setup.clock.now += 11 * MINUTE;
		expect(
			await editSavedCommand(setup.consoleAs('pat'), id, {
				command: savedFields({ aiUnattended: false }),
				recheck: NO_RECHECK
			})
		).toMatchObject({ kind: 'refused', status: 403 });
		expect(
			await editSavedCommand(setup.consoleAs('admin'), id, {
				command: savedFields({ aiUnattended: false }),
				recheck: NO_RECHECK
			})
		).toMatchObject({ kind: 'refused', status: 403 });
		expect(await removeSavedCommand(setup.consoleAs('pat'), id, NO_RECHECK)).toMatchObject({
			kind: 'refused',
			status: 403
		});
		expect(await removeSavedCommand(setup.consoleAs('admin'), id, NO_RECHECK)).toMatchObject({
			kind: 'refused',
			status: 403
		});
		expect(findSavedCommand(setup.database, id)?.aiUnattended).toBe(true);
	});

	it('SC2: names are unique ignoring case, and every machine group must exist', async () => {
		const setup = await setUpAssistantRuns();
		await written(setup);
		expect(
			await createSavedCommand(setup.consoleAs('admin'), {
				command: savedFields({ name: 'FREE SPACE' }),
				recheck: NO_RECHECK
			})
		).toMatchObject({ kind: 'refused', status: 409 });
		expect(
			await createSavedCommand(setup.consoleAs('admin'), {
				command: savedFields({
					name: 'Elsewhere',
					machineGroupIds: ['99999999-9999-4999-8999-999999999999']
				}),
				recheck: NO_RECHECK
			})
		).toMatchObject({ kind: 'refused', status: 400 });
	});

	it('SC5, SC7: each change is audited with before and after, and raises the version', async () => {
		const setup = await setUpAssistantRuns();
		const id = await written(setup);
		expect(listAudit(setup.database, 5)[0]).toMatchObject({
			kind: 'saved-command-created',
			actorUserId: setup.people.admin.id,
			target: 'Free space',
			detail: {
				'Linux script (sh)': LINUX_SCRIPT,
				'AI may run it without approval': 'yes',
				'machine groups': 'All machines',
				parameters: 'mount (Mount): Path'
			}
		});
		const edited = await editSavedCommand(setup.consoleAs('admin'), id, {
			command: savedFields({ aiUnattended: false, timeoutMs: 60_000 }),
			recheck: NO_RECHECK
		});
		expect(edited).toEqual({ kind: 'written', id, version: 2 });
		expect(listAudit(setup.database, 5)[0]).toMatchObject({
			kind: 'saved-command-changed',
			detail: {
				version: '1 → 2',
				'AI may run it without approval, before': 'yes',
				'AI may run it without approval, after': 'no',
				'time limit, before': '30 s',
				'time limit, after': '60 s'
			}
		});
		expect(listAudit(setup.database, 5)[0]?.detail).not.toHaveProperty('name, before');
		// Saved unchanged: nothing recorded, the version stays.
		expect(
			await editSavedCommand(setup.consoleAs('admin'), id, {
				command: savedFields({ aiUnattended: false, timeoutMs: 60_000 }),
				recheck: NO_RECHECK
			})
		).toEqual({ kind: 'written', id, version: 2 });
		expect(listAudit(setup.database, 5)[0]?.kind).toBe('saved-command-changed');
		expect(listAudit(setup.database, 5)[1]?.kind).toBe('saved-command-created');
		expect(await removeSavedCommand(setup.consoleAs('admin'), id, NO_RECHECK)).toEqual({
			kind: 'deleted'
		});
		expect(listAudit(setup.database, 5)[0]).toMatchObject({
			kind: 'saved-command-deleted',
			target: 'Free space',
			detail: { version: '2', 'Linux script (sh)': LINUX_SCRIPT }
		});
		expect(findSavedCommand(setup.database, id)).toBeUndefined();
	});
});

describe('people running a saved command (SC1, SC10, SC12, SC13)', () => {
	it('SC1, SC10: offered where the person may run commands, in its groups, on its systems', async () => {
		const setup = await setUpAssistantRuns();
		const id = await written(setup);
		const command = findSavedCommand(setup.database, id);
		if (command === undefined) throw new Error('missing');
		// Pat runs commands on mint, reception, office, studio, old and payroll; Linux ones only.
		expect(
			savedRunMachines(setup.database, setup.people.pat, command).map((machine) => machine.name)
		).toEqual(['mint', 'old', 'payroll', 'reception']);
		expect(savedCommandsFor(setup.database, setup.people.pat).map((entry) => entry.name)).toEqual([
			'Free space'
		]);
		// Kim may not run commands anywhere: nothing to offer.
		expect(savedCommandsFor(setup.database, setup.people.kim)).toEqual([]);
	});

	it('SC12, SC13: an ordinary run marked with the saved command; the values only in the environment', async () => {
		const setup = await setUpAssistantRuns();
		const id = await written(
			setup,
			savedFields({
				scripts: [
					{ osFamily: 'linux', shell: 'bash', script: LINUX_SCRIPT },
					{ osFamily: 'windows', shell: 'powershell', script: WINDOWS_SCRIPT }
				]
			})
		);
		const linux = connect(setup.machine.mint);
		const windows = connect(setup.machine.office);
		const request = runRequest([setup.machine.mint, setup.machine.office], {
			values: { mount: 'C:\\Data' }
		});
		expect(planSavedRun(setup.consoleAs('pat'), id, request)).toMatchObject({
			kind: 'planned',
			commands: [
				{ osFamily: 'linux', command: expect.stringContaining("BMUSTER_PARAM_MOUNT='C:\\Data'") as unknown },
				{ osFamily: 'windows', command: expect.stringContaining('FromBase64String(') as unknown }
			]
		});
		const started = await startSavedRun(setup.consoleAs('pat'), id, request);
		expect(started.kind).toBe('started');
		const runId = started.kind === 'started' ? started.runId : '';
		expect(findRun(setup.database, runId)).toMatchObject({
			requester: 'person',
			savedCommandId: id,
			savedCommandName: 'Free space',
			savedCommandVersion: 1,
			savedCommandEffect: 'reads-only'
		});
		const [windowsTicket] = windows;
		const [linuxTicket] = linux;
		// The admin's script, byte for byte, after the prelude; the value never in the script part.
		expect(linuxTicket?.purpose.command.endsWith(`\n\n${LINUX_SCRIPT}`)).toBe(true);
		expect(windowsTicket?.purpose.command.endsWith(`\n\n${WINDOWS_SCRIPT}`)).toBe(true);
		expect(windowsTicket?.purpose.command).not.toContain('C:\\Data');
		expect(windowsTicket?.purpose.command).toContain(
			`$env:BMUSTER_PARAM_MOUNT = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${Buffer.from('C:\\Data').toString('base64')}'))`
		);
		expect(runViewFor(setup.database, setup.people.pat, runId, setup.runner)?.saved).toEqual({
			kind: 'saved',
			name: 'Free space',
			version: 1,
			effect: 'reads-only',
			values: [{ label: 'mount', value: 'C:\\Data' }],
			preApproved: false
		});
	});

	it('SC12: every check again on the server, refused whole', async () => {
		const setup = await setUpAssistantRuns();
		const id = await written(setup);
		const pat = setup.consoleAs('pat');
		const mintOnly = grantAccess(setup.database, {
			adminId: setup.people.admin.id,
			name: 'Mint',
			memberIds: [],
			machineIds: [setup.machine.mint],
			permissions: ['view'],
			consent: 'unattended'
		}).machineGroupId;
		const narrow = await written(
			setup,
			savedFields({ name: 'Narrow', machineGroupIds: [mintOnly] })
		);
		const cases: [string, SavedRunRequest, string][] = [
			[id, runRequest([setup.machine.mint], { version: 2 }), 'was changed since you opened it'],
			[
				id,
				runRequest([setup.machine.mint], { values: { mount: '$(reboot)' } }),
				'Mount: Letters, digits'
			],
			[id, runRequest([setup.machine.office]), 'has no Windows script'],
			[narrow, runRequest([setup.machine.reception]), 'not in a machine group Narrow may run on'],
			[id, runRequest([setup.machine.mint], { confirmCount: 2 }), 'Type 1']
		];
		for (const [commandId, request, message] of cases) {
			expect(await startSavedRun(pat, commandId, request)).toMatchObject({
				kind: 'refused',
				message: expect.stringContaining(message) as unknown
			});
		}
		// Kim cannot run commands on mint: refused whole, naming it.
		expect(
			await startSavedRun(setup.consoleAs('kim'), id, runRequest([setup.machine.mint]))
		).toEqual({
			kind: 'refused',
			status: 403,
			message: 'You cannot run commands on mint. Take them out of the selection and try again.'
		});
		// Switched off looks missing.
		await editSavedCommand(setup.consoleAs('admin'), id, {
			command: savedFields({ enabled: false }),
			recheck: NO_RECHECK
		});
		expect(await startSavedRun(pat, id, runRequest([setup.machine.mint], { version: 2 }))).toEqual({
			kind: 'refused',
			status: 404,
			message: 'No saved command with this id.'
		});
	});

	it('SC7: editing or deleting the saved command later leaves past runs as they ran', async () => {
		const setup = await setUpAssistantRuns();
		const id = await written(setup);
		connect(setup.machine.mint);
		const started = await startSavedRun(
			setup.consoleAs('pat'),
			id,
			runRequest([setup.machine.mint])
		);
		const runId = started.kind === 'started' ? started.runId : '';
		const before = scriptsOf(setup.database, [runId]);
		await editSavedCommand(setup.consoleAs('admin'), id, {
			command: savedFields({
				scripts: [{ osFamily: 'linux', shell: 'sh', script: 'echo changed' }]
			}),
			recheck: NO_RECHECK
		});
		await removeSavedCommand(setup.consoleAs('admin'), id, NO_RECHECK);
		expect(scriptsOf(setup.database, [runId])).toEqual(before);
		expect(findRun(setup.database, runId)).toMatchObject({
			savedCommandName: 'Free space',
			savedCommandVersion: 1
		});
	});
});

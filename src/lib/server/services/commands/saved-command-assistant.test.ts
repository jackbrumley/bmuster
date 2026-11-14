import { afterEach, describe, expect, it } from 'vitest';
import { getCommandResultInput, runSavedCommandInput } from '#lib/schemas/mcp/tools.ts';
import { grantAccess } from '#tests/helpers/access.ts';
import {
	agentAnswers,
	asAsked,
	connect,
	disconnectAgents,
	setUpAssistantRuns
} from '#tests/helpers/assistant-runs.ts';
import {
	addSaved,
	LINUX_SCRIPT,
	savedFields,
	WINDOWS_SCRIPT
} from '#tests/helpers/saved-commands.ts';
import { listAudit } from '../audit/audit.ts';
import {
	getCommandResultTool,
	listSavedCommandsTool,
	resultText,
	runSavedCommandTool
} from '../mcp/command-tools.ts';
import { stopAllAiAccess } from '../oauth/grants.ts';
import { writeUnattendedAllowed } from '../oauth/mcp-settings.ts';
import { withActorNames } from '../users/activity-feed.ts';
import { approveRun } from './assistant-runs.ts';
import { findRun, insertRun, machinesOf, scriptsOf } from './command-runs.ts';
import { updateSavedCommand } from './saved-commands.ts';

afterEach(disconnectAgents);

const run = (input: { command: string; machines: string[]; parameters?: Record<string, string> }) =>
	runSavedCommandInput.parse({ parameters: { mount: '/var' }, reason: 'Check disk', ...input });

/** A server with one saved command, Pat's assistant connected, and mint's agent listening. */
async function setUp(fields = savedFields()) {
	const setup = await setUpAssistantRuns();
	const savedId = addSaved(setup.database, setup.people.admin.id, fields);
	const tickets = connect(setup.machine.mint);
	const pat = await setup.assistantOf('pat');
	return { ...setup, savedId, tickets, pat };
}

describe('list_saved_commands (SPEC-SAVED-COMMANDS SC15)', () => {
	it('SC15: the switched-on commands the assistant may use, with machines and approval, never the script', async () => {
		const { database, people, tools, pat, assistantOf } = await setUp();
		addSaved(database, people.admin.id, savedFields({ name: 'Switched off', enabled: false }));
		addSaved(
			database,
			people.admin.id,
			savedFields({ name: 'Asks first', aiUnattended: false, effect: 'changes' })
		);
		const listed = listSavedCommandsTool(tools(pat));
		expect(listed).toMatchObject({
			kind: 'ok',
			output: {
				runsWithoutApprovalLeftThisHour: 60,
				commands: [
					{
						name: 'Asks first',
						label: 'Changes the machine',
						runsWithoutApproval: false
					},
					{
						name: 'Free space',
						description: 'Free space on one mount.',
						label: 'Reads only',
						systems: ['linux'],
						runsWithoutApproval: true,
						parameters: [
							{
								name: 'mount',
								label: 'Mount',
								type: 'text',
								pattern: '^[A-Za-z0-9_.:/\\\\ -]{1,260}$',
								min: null,
								max: null,
								choices: []
							}
						],
						// Linux machines open to Pat's AI commands; payroll has no AI commands, office no script.
						machines: [
							{ name: 'mint', system: 'linux', runsWithoutApproval: true },
							{ name: 'old', system: 'linux', runsWithoutApproval: true },
							{ name: 'reception', system: 'linux', runsWithoutApproval: true }
						]
					}
				]
			}
		});
		expect(JSON.stringify(listed)).not.toContain('df -h');
		// Kim holds AI commands on mint but not Run commands: it would need approval there.
		const kim = listSavedCommandsTool(tools(await assistantOf('kim')));
		expect(kim).toMatchObject({
			kind: 'ok',
			output: {
				commands: [
					{ name: 'Asks first' },
					{ name: 'Free space', machines: [{ name: 'mint', runsWithoutApproval: false }] }
				]
			}
		});
	});
});

describe('run_saved_command (SC16)', () => {
	it('SC16: refused for an unknown or switched-off command, bad values, and machines it cannot use', async () => {
		const { database, people, machine, tools, pat, tickets } = await setUp();
		addSaved(database, people.admin.id, savedFields({ name: 'Off', enabled: false }));
		const onlyMint = addSaved(
			database,
			people.admin.id,
			savedFields({
				name: 'Mint only',
				machineGroupIds: [
					// Pat's AI machine group holds mint, reception, office, studio and old; this one only mint.
					grantAccess(database, {
						adminId: people.admin.id,
						name: 'Mint',
						memberIds: [],
						machineIds: [machine.mint],
						permissions: ['view'],
						consent: 'unattended'
					}).machineGroupId
				]
			})
		);
		const both = addSaved(
			database,
			people.admin.id,
			savedFields({
				name: 'Both',
				scripts: [
					{ osFamily: 'linux', shell: 'sh', script: LINUX_SCRIPT },
					{ osFamily: 'windows', shell: 'powershell', script: WINDOWS_SCRIPT }
				]
			})
		);
		const refusals: [Parameters<typeof run>[0], string][] = [
			[{ command: 'Nothing', machines: ['mint'] }, 'No saved command called Nothing'],
			[{ command: 'Off', machines: ['mint'] }, 'No saved command called Off'],
			[{ command: 'Free space', machines: ['payroll'] }, 'payroll is not open to AI commands'],
			[
				{ command: onlyMint, machines: ['reception'] },
				'reception is not in a machine group Mint only may run on'
			],
			[{ command: 'Free space', machines: ['office'] }, 'has no Windows script'],
			[{ command: 'Free space', machines: ['studio'] }, 'studio runs macOS'],
			[{ command: both, machines: ['mint', 'office'] }, 'in separate calls'],
			[
				{ command: 'Free space', machines: ['mint'], parameters: { mount: '/var; rm -rf /' } },
				'Mount: Letters, digits, spaces'
			],
			[
				{ command: 'Free space', machines: ['mint'], parameters: { mount: '/', extra: 'x' } },
				'has no parameter called extra'
			],
			[{ command: 'Free space', machines: ['mint'], parameters: {} }, 'Fill in Mount']
		];
		for (const [input, message] of refusals) {
			expect(await runSavedCommandTool(tools(pat), run(input))).toEqual({
				kind: 'error',
				message: expect.stringContaining(message) as unknown
			});
		}
		expect(tickets).toEqual([]);
		expect(machinesOf(database, [])).toEqual([]);
	});
});

describe('unattended only when all hold (SC17, SC18)', () => {
	it('SC17: every condition holds: it runs at once as the person, values only in the environment', async () => {
		const { database, relay, people, tools, pat, tickets } = await setUp();
		const result = await runSavedCommandTool(
			tools(pat),
			run({ command: 'free SPACE', machines: ['mint'] })
		);
		const runId = result.kind === 'ok' ? result.output.runId : '';
		expect(findRun(database, runId)).toMatchObject({
			status: 'running',
			requester: 'assistant',
			preApproved: true,
			decidedBy: null,
			savedCommandName: 'Free space',
			savedCommandVersion: 1
		});
		expect(tickets).toHaveLength(1);
		const [ticket] = tickets;
		expect(ticket).toMatchObject({
			user: { id: people.pat.id },
			purpose: {
				kind: 'exec',
				shell: 'sh',
				command: `# BMuster: saved command parameters\nexport BMUSTER_PARAM_MOUNT='/var'\n\n${LINUX_SCRIPT}`,
				timeoutMs: 30_000
			}
		});
		expect(ticket?.permissions).toContain('run-commands');
		if (ticket !== undefined) {
			agentAnswers(relay, ticket, { stdout: '/var 12G free', stderr: '', exitCode: 0 });
		}
		const read = await getCommandResultTool(
			tools(pat),
			getCommandResultInput.parse({ runId, waitSeconds: 0 })
		);
		expect(read).toMatchObject({
			kind: 'ok',
			output: {
				status: 'finished',
				commandRun: null,
				savedCommand: {
					name: 'Free space',
					version: 1,
					label: 'Reads only',
					ranWithoutApproval: true
				},
				output: { stdout: { text: '/var 12G free' } }
			}
		});
		// SC18: the script never reaches the assistant, not even in the text copy.
		if (read.kind === 'ok') {
			expect(resultText(read.output)).not.toContain('df -h');
			expect(resultText(read.output)).toContain(
				'Saved command: Free space (version 1, Reads only)'
			);
		}
	});

	it('SC17: each condition a person could still approve sends it to Approvals, saying why', async () => {
		const cases: {
			name: string;
			prepare: (setup: Awaited<ReturnType<typeof setUp>>) => Promise<string> | string;
			why: string;
		}[] = [
			{
				name: 'the command’s AI switch is off',
				prepare: ({ database, people }) =>
					addSaved(database, people.admin.id, savedFields({ name: 'No AI', aiUnattended: false })),
				why: 'an admin has not let AI run No AI without approval'
			},
			{
				name: 'the server switch is off',
				prepare: ({ database, people, savedId }) => {
					writeUnattendedAllowed(database, people.admin.id, false, Date.now());
					return savedId;
				},
				why: 'this server does not let AI run saved commands without approval'
			}
		];
		for (const entry of cases) {
			const setup = await setUp();
			const command = await entry.prepare(setup);
			const result = await runSavedCommandTool(
				setup.tools(setup.pat),
				run({ command, machines: ['mint'] })
			);
			expect(result, entry.name).toMatchObject({
				kind: 'ok',
				output: {
					status: 'pending-approval',
					message: expect.stringContaining(entry.why) as unknown,
					savedCommand: { ranWithoutApproval: false }
				}
			});
			expect(setup.tickets, entry.name).toEqual([]);
			disconnectAgents();
		}
	});

	it('SC17: a person without Run commands on a machine: approval, never a ticket carrying it', async () => {
		const { tools, assistantOf, tickets } = await setUp();
		const kim = await assistantOf('kim');
		const result = await runSavedCommandTool(
			tools(kim),
			run({ command: 'Free space', machines: ['mint'] })
		);
		expect(result).toMatchObject({
			kind: 'ok',
			output: {
				status: 'pending-approval',
				message: expect.stringContaining('kim cannot run commands on mint') as unknown
			}
		});
		expect(tickets).toEqual([]);
	});
});

describe('checked again at each machine’s turn (SC19)', () => {
	/** A pre-approved run already recorded, as `run_saved_command` makes it, not yet begun. */
	function recorded(setup: Awaited<ReturnType<typeof setUp>>): string {
		const runId = crypto.randomUUID();
		insertRun(setup.database, {
			id: runId,
			startedBy: setup.people.pat.id,
			startedAt: setup.clock.now,
			timeoutMs: 30_000,
			rerunOf: null,
			origin: { kind: 'pre-approved', grantId: setup.pat.grantId, reason: '' },
			saved: {
				kind: 'saved',
				id: setup.savedId,
				name: 'Free space',
				version: 1,
				effect: 'reads-only',
				values: { mount: '/' }
			},
			scripts: [{ osFamily: 'linux', shell: 'sh', command: LINUX_SCRIPT }],
			machines: [{ machineId: setup.machine.mint, status: 'waiting', skipReason: null }]
		});
		return runId;
	}

	const changes: {
		name: string;
		change: (setup: Awaited<ReturnType<typeof setUp>>) => void;
		reason: string;
	}[] = [
		{
			name: 'edited',
			change: ({ database, savedId, people }) => {
				updateSavedCommand(database, {
					id: savedId,
					fields: savedFields({ description: 'Changed' }),
					version: 2,
					userId: people.admin.id,
					now: Date.now()
				});
			},
			reason: 'The saved command was changed before its turn.'
		},
		{
			name: 'switched off',
			change: ({ database, savedId, people }) => {
				updateSavedCommand(database, {
					id: savedId,
					fields: savedFields({ enabled: false }),
					version: 1,
					userId: people.admin.id,
					now: Date.now()
				});
			},
			reason: 'The saved command was switched off before its turn.'
		},
		{
			name: 'AI switch off',
			change: ({ database, savedId, people }) => {
				updateSavedCommand(database, {
					id: savedId,
					fields: savedFields({ aiUnattended: false }),
					version: 1,
					userId: people.admin.id,
					now: Date.now()
				});
			},
			reason: 'AI may no longer run the saved command without approval.'
		},
		{
			name: 'server switch off',
			change: ({ database, people }) => {
				writeUnattendedAllowed(database, people.admin.id, false, Date.now());
			},
			reason: 'This server stopped letting AI run saved commands without approval.'
		},
		{
			name: 'Stop all AI access',
			change: ({ database, people }) => {
				stopAllAiAccess(database, people.admin.id, Date.now());
			},
			reason: 'AI assistants were turned off before its turn.'
		}
	];

	for (const entry of changes) {
		it(`SC19: ${entry.name} before its turn: skipped with the reason, nothing sent`, async () => {
			const setup = await setUp();
			const runId = recorded(setup);
			entry.change(setup);
			setup.runner.begin(runId, '');
			expect(machinesOf(setup.database, [runId])).toMatchObject([
				{ status: 'skipped', skipReason: entry.reason }
			]);
			expect(setup.tickets).toEqual([]);
		});
	}

	it('SC19: unchanged, it runs as the person', async () => {
		const setup = await setUp();
		const runId = recorded(setup);
		setup.runner.begin(runId, '');
		expect(setup.tickets).toMatchObject([{ user: { id: setup.people.pat.id } }]);
	});
});

describe('hourly cap (SC20)', () => {
	it('SC20: past 60 runs without approval an hour, requests go to Approvals', async () => {
		const { tools, pat, clock } = await setUp();
		disconnectAgents();
		for (let index = 0; index < 60; index += 1) {
			const result = await runSavedCommandTool(
				tools(pat),
				run({ command: 'Free space', machines: ['reception'] })
			);
			expect(result).toMatchObject({
				kind: 'ok',
				output: { savedCommand: { ranWithoutApproval: true } }
			});
		}
		const over = await runSavedCommandTool(
			tools(pat),
			run({ command: 'Free space', machines: ['reception'] })
		);
		expect(over).toMatchObject({
			kind: 'ok',
			output: {
				status: 'pending-approval',
				message: expect.stringContaining(
					'already ran 60 saved commands without approval'
				) as unknown
			}
		});
		expect(listSavedCommandsTool(tools(pat))).toMatchObject({
			output: { runsWithoutApprovalLeftThisHour: 0 }
		});
		// An hour on, the cap has room again.
		clock.now += 60 * 60_000 + 1;
		const later = await runSavedCommandTool(
			tools(pat),
			run({ command: 'Free space', machines: ['reception'] })
		);
		expect(later).toMatchObject({
			kind: 'ok',
			output: { savedCommand: { ranWithoutApproval: true } }
		});
	});
});

describe('server switch (SC21)', () => {
	it('SC21: on by default; off sends every request to Approvals; audited', async () => {
		const { database, people, tools, pat } = await setUp();
		expect(listSavedCommandsTool(tools(pat))).toMatchObject({
			output: { commands: [{ runsWithoutApproval: true }] }
		});
		writeUnattendedAllowed(database, people.admin.id, false, Date.now());
		const off = listSavedCommandsTool(tools(pat));
		expect(off).toMatchObject({ output: { commands: [{ runsWithoutApproval: false }] } });
		expect(
			off.kind === 'ok' &&
				off.output.commands.every((command) =>
					command.machines.every((machine) => !machine.runsWithoutApproval)
				)
		).toBe(true);
		// Requests then wait for a person, as SC17's server switch case shows.
		expect(listAudit(database, 5)).toContainEqual(
			expect.objectContaining({
				kind: 'setting-changed',
				target: 'Allow AI to run saved commands without approval',
				detail: { from: 'on', to: 'off' }
			})
		);
	});
});

describe('audit (SC22)', () => {
	it('SC22: "<person> via <assistant>, pre-approved saved command <name>"; requests say why', async () => {
		const { database, people, tools, pat, assistantOf } = await setUp();
		await runSavedCommandTool(tools(pat), run({ command: 'Free space', machines: ['mint'] }));
		const started = listAudit(database, 50).filter((entry) => entry.kind === 'command-run-started');
		expect(started).toHaveLength(1);
		expect(started[0]).toMatchObject({
			actorUserId: people.pat.id,
			detail: {
				'saved command': 'Free space (version 1)',
				parameters: 'mount=/var',
				approval: 'Pre-approved saved command: no person approved this run'
			}
		});
		const [entry] = withActorNames(database, started);
		expect(entry?.actor).toEqual({
			kind: 'user',
			name: 'pat via Claude Code, pre-approved saved command Free space'
		});
		await runSavedCommandTool(
			tools(await assistantOf('kim')),
			run({ command: 'Free space', machines: ['mint'] })
		);
		expect(
			listAudit(database, 50).find((record) => record.kind === 'command-run-requested')
		).toMatchObject({
			detail: {
				'saved command': 'Free space (version 1)',
				'needs approval because': expect.stringContaining(
					'kim cannot run commands on mint'
				) as unknown
			}
		});
	});
});

describe('approval card (SC23)', () => {
	it('SC23: a saved command request is approved as it is; an edit is refused', async () => {
		const { database, tools, consoleAs, pat, tickets } = await setUp(
			savedFields({ aiUnattended: false })
		);
		const asked = await runSavedCommandTool(
			tools(pat),
			run({ command: 'Free space', machines: ['mint'] })
		);
		const runId = asked.kind === 'ok' ? asked.output.runId : '';
		const command = scriptsOf(database, [runId])[0]?.command ?? '';
		expect(command).toContain(LINUX_SCRIPT);
		const edited = await approveRun(
			consoleAs('pat'),
			runId,
			asAsked(`${command}\necho more`, 30_000, 1)
		);
		expect(edited).toEqual({
			kind: 'refused',
			status: 400,
			message: 'A saved command is approved as it is: it cannot be edited here.'
		});
		expect(await approveRun(consoleAs('pat'), runId, asAsked(command, 60_000, 1))).toMatchObject({
			kind: 'refused',
			status: 400
		});
		expect(await approveRun(consoleAs('pat'), runId, asAsked(command, 30_000, 1))).toEqual({
			kind: 'approved',
			runId
		});
		expect(tickets).toMatchObject([{ purpose: { command } }]);
	});
});

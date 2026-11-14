import { beforeEach, describe, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';
import {
	emptyCounts,
	type RunMachineOutput,
	type RunMachineStatus,
	type RunMachineView,
	type RunView
} from '#lib/domain/commands/commands.ts';
import { COMMAND_RUN_EVENT } from '#lib/schemas/commands/commands.ts';
import { FakeEventSource, feed } from '#tests/helpers/fake-event-source.ts';
import RunResults from './run-results.svelte';

const goto = vi.hoisted(() => vi.fn((_url: string, _options: unknown) => Promise.resolve()));
vi.mock('$app/navigation', () => ({ goto }));

const RUN = '99999999-9999-4999-8999-999999999999';
const NOW = Date.parse('2026-11-14T12:00:00.000Z');

function row(index: number, status: RunMachineStatus, exitCode: number | null): RunMachineView {
	return {
		machineId: `00000000-0000-4000-8000-00000000000${index}`,
		machineName: `PC ${index}`,
		status,
		reason: status === 'lost' ? 'The connection to the machine was lost.' : '',
		exitCode,
		durationMs: exitCode === null ? null : 1200,
		output: exitCode === null ? { kind: 'none' } : { kind: 'kept', bytes: 12 }
	};
}

function view(machines: RunMachineView[], status: RunView['status'] = 'finished'): RunView {
	const counts = emptyCounts();
	for (const machine of machines) counts[machine.status] += 1;
	return {
		id: RUN,
		startedBy: 'Ada',
		origin: { kind: 'person' },
		saved: { kind: 'none' },
		startedIso: '2026-11-14T11:58:00.000Z',
		endedIso: status === 'running' ? null : '2026-11-14T11:59:00.000Z',
		status,
		timeoutMs: 30_000,
		scripts: [
			{ osFamily: 'windows', shell: 'powershell', command: 'Restart-Service Spooler' },
			{ osFamily: 'linux', shell: 'bash', command: 'systemctl restart cups' }
		],
		machines,
		counts,
		canCancel: status === 'running'
	};
}

beforeEach(async () => {
	goto.mockClear();
	FakeEventSource.opened = [];
	vi.stubGlobal('EventSource', FakeEventSource);
	await page.viewport(1280, 800);
});

describe('results (SPEC-COMMANDS C16, C18)', () => {
	it('C18: Run again on failed and offline opens Run command with those machines and the same commands', async () => {
		const machines = [
			row(1, 'succeeded', 0),
			row(2, 'failed', 5),
			row(3, 'offline', null),
			row(4, 'timed-out', null),
			row(5, 'lost', null),
			row(6, 'skipped', null)
		];
		const screen = await render(RunResults, {
			initial: view(machines),
			now: NOW,
			openMachineId: null
		});
		await expect
			.element(
				screen.getByText('1 succeeded · 1 failed · 1 timed out · 1 offline · 1 skipped · 1 lost')
			)
			.toBeVisible();
		await screen.getByRole('button', { name: 'Run again on failed and offline' }).click();
		expect(goto).toHaveBeenCalledWith('/commands/new', {
			state: {
				commandDraft: {
					machineIds: [machines[1], machines[2], machines[3], machines[4]].map(
						(machine) => machine?.machineId
					),
					scripts: view([]).scripts,
					timeoutMs: 30_000,
					rerunOf: RUN
				}
			}
		});
	});

	it('C18: nothing to run again when every machine succeeded', async () => {
		const screen = await render(RunResults, {
			initial: view([row(1, 'succeeded', 0), row(2, 'succeeded', 0)]),
			now: NOW,
			openMachineId: null
		});
		await expect.element(screen.getByText('2 succeeded')).toBeVisible();
		expect(
			screen.getByRole('button', { name: 'Run again on failed and offline' }).query()
		).toBeNull();
	});

	it('C16: rows update live from the run’s events', async () => {
		const screen = await render(RunResults, {
			initial: view([row(1, 'running', null), row(2, 'waiting', null)], 'running'),
			now: NOW,
			openMachineId: null
		});
		await expect.element(screen.getByText('1 waiting · 1 running')).toBeVisible();
		await expect.element(screen.getByRole('button', { name: 'Cancel run' })).toBeVisible();
		await expect.poll(() => FakeEventSource.opened.length).toBe(1);
		feed().send(COMMAND_RUN_EVENT, view([row(1, 'succeeded', 0), row(2, 'failed', 2)]));
		await expect.element(screen.getByText('1 succeeded · 1 failed')).toBeVisible();
		expect(screen.getByRole('button', { name: 'Cancel run' }).query()).toBeNull();
	});
});

describe('an AI assistant’s run on its results page (SPEC-MCP M28)', () => {
	it('M28: who asked via which assistant, who approved, the reason and the requested command', async () => {
		const screen = await render(RunResults, {
			initial: {
				...view([row(1, 'succeeded', 0)]),
				startedBy: 'Jack Brumley via Claude Code',
				origin: {
					kind: 'assistant',
					assistant: 'Claude Code',
					verified: true,
					reason: 'Check the print spooler',
					expiresIso: '2026-11-14T12:08:00.000Z',
					decision: {
						kind: 'approved',
						by: 'Bea Second',
						atIso: '2026-11-14T11:58:30.000Z',
						edit: {
							kind: 'edited',
							requestedCommand: 'Restart-Service Spooler -Force',
							requestedTimeoutMs: 60_000
						}
					}
				}
			},
			now: NOW,
			openMachineId: null
		});
		await expect
			.element(screen.getByText(/Started by Jack Brumley via Claude Code/u))
			.toBeVisible();
		await expect.element(screen.getByText('Approved by Bea Second, edited')).toBeVisible();
		await expect
			.element(screen.getByText('Claude Code said: Check the print spooler'))
			.toBeVisible();
		await expect.element(screen.getByText('Restart-Service Spooler -Force')).toBeVisible();
	});

	it('M28: a denied request shows who denied it and the note', async () => {
		const screen = await render(RunResults, {
			initial: {
				...view([row(1, 'cancelled', null)], 'denied'),
				origin: {
					kind: 'assistant',
					assistant: 'Claude Code',
					verified: true,
					reason: 'Clean up',
					expiresIso: '2026-11-14T12:08:00.000Z',
					decision: {
						kind: 'denied',
						by: 'Bea Second',
						atIso: '2026-11-14T11:58:30.000Z',
						note: 'Not on a Friday'
					}
				}
			},
			now: NOW,
			openMachineId: null
		});
		await expect.element(screen.getByText('Denied by Bea Second: Not on a Friday')).toBeVisible();
	});
});

describe('a running machine’s output, live (SPEC-COMMANDS C23, C24)', () => {
	/** The output endpoint, answering with whatever `state.current` holds now. */
	function serveOutput(first: RunMachineOutput) {
		const state = { current: first };
		const fetch = vi.fn<typeof globalThis.fetch>(() =>
			Promise.resolve(
				new Response(JSON.stringify(state.current), {
					status: 200,
					headers: { 'content-type': 'application/json' }
				})
			)
		);
		vi.stubGlobal('fetch', fetch);
		return { state, fetch };
	}

	function live(stdout: string, lastOutputMsAgo: number | null): RunMachineOutput {
		return {
			kind: 'live',
			stdout,
			stderr: '',
			stdoutTruncated: false,
			stderrTruncated: false,
			bytes: stdout.length,
			runningForMs: 65_000,
			lastOutputMsAgo
		};
	}

	function running(bytes: number): RunMachineView {
		return { ...row(1, 'running', null), output: { kind: 'live', bytes } };
	}

	it('C23: tapping a running machine shows its output so far, and how long it has run', async () => {
		const { fetch } = serveOutput(live('Reading package lists...\n', 3_000));
		const screen = await render(RunResults, {
			initial: view([running(25)], 'running'),
			now: NOW,
			openMachineId: null
		});
		await screen.getByRole('button', { name: /PC 1/u }).click();
		await expect.element(screen.getByText('Reading package lists...')).toBeVisible();
		await expect
			.element(screen.getByText(/^Running for 1 min \d+ s · last output \d+ s ago$/u))
			.toBeVisible();
		expect(fetch).toHaveBeenCalledWith(
			`/api/commands/runs/${RUN}/machines/00000000-0000-4000-8000-000000000001`,
			expect.anything()
		);
	});

	it('C23: the panel follows new output from the run’s events, then shows the final result', async () => {
		const { state, fetch } = serveOutput(live('one\n', 1_000));
		const screen = await render(RunResults, {
			initial: view([running(4)], 'running'),
			now: NOW,
			openMachineId: null
		});
		await screen.getByRole('button', { name: /PC 1/u }).click();
		await expect.element(screen.getByText('one')).toBeVisible();
		await expect.poll(() => FakeEventSource.opened.length).toBe(1);

		state.current = live(`one\n${'line\n'.repeat(200)}two\n`, 0);
		feed().send(COMMAND_RUN_EVENT, view([running(1008)], 'running'));
		await expect.element(screen.getByText(/two/u)).toBeInTheDocument();
		const box = screen.getByText(/two/u).element();
		await expect
			.poll(() => box.scrollTop + box.clientHeight)
			.toBeGreaterThanOrEqual(box.scrollHeight - 8);

		// The same size again is not read again.
		const reads = fetch.mock.calls.length;
		feed().send(COMMAND_RUN_EVENT, view([running(1008)], 'running'));
		expect(fetch.mock.calls.length).toBe(reads);

		state.current = {
			kind: 'kept',
			stdout: 'all done\n',
			stderr: '',
			stdoutTruncated: false,
			stderrTruncated: false
		};
		feed().send(COMMAND_RUN_EVENT, view([row(1, 'succeeded', 0)]));
		await expect.element(screen.getByText('all done')).toBeVisible();
		expect(screen.getByText(/^Running for/u).query()).toBeNull();
	});

	it('C24: a link to the run naming a machine opens that machine’s output on arrival', async () => {
		serveOutput(live('Unpacking...\n', 2_000));
		const screen = await render(RunResults, {
			initial: view([running(13), row(2, 'waiting', null)], 'running'),
			now: NOW,
			openMachineId: '00000000-0000-4000-8000-000000000001'
		});
		await expect.element(screen.getByText('Output: PC 1')).toBeVisible();
		await expect.element(screen.getByText('Unpacking...')).toBeVisible();
	});

	it('C24: a machine not among the person’s rows opens nothing', async () => {
		const { fetch } = serveOutput(live('secret\n', 2_000));
		const screen = await render(RunResults, {
			initial: view([running(13)], 'running'),
			now: NOW,
			openMachineId: '00000000-0000-4000-8000-000000000009'
		});
		await expect.element(screen.getByText('1 running')).toBeVisible();
		expect(screen.getByText(/^Output:/u).query()).toBeNull();
		expect(fetch).not.toHaveBeenCalled();
	});
});

describe('a saved command’s run (SPEC-SAVED-COMMANDS SC14)', () => {
	it('SC14: names the saved command, its version, its values and its label; Changes the machine in the warning colour', async () => {
		const screen = await render(RunResults, {
			initial: {
				...view([row(1, 'failed', 1)]),
				saved: {
					kind: 'saved',
					name: 'Restart spooler',
					version: 4,
					effect: 'changes',
					values: [{ label: 'service', value: 'Spooler' }],
					preApproved: true
				},
				origin: {
					kind: 'assistant',
					assistant: 'Claude Code',
					verified: true,
					reason: '',
					expiresIso: '2026-11-14T12:10:00.000Z',
					decision: { kind: 'pre-approved' }
				}
			},
			now: NOW,
			openMachineId: null
		});
		await expect
			.element(screen.getByText('Saved command: Restart spooler (version 4)'))
			.toBeVisible();
		await expect.element(screen.getByText('service: Spooler')).toBeVisible();
		await expect
			.element(screen.getByText('Ran without approval: a saved command an admin let AI run'))
			.toBeVisible();
		const label = screen.getByText('Changes the machine', { exact: true });
		await expect.element(label).toBeVisible();
		expect(label.element().classList.contains('changes')).toBe(true);
		// Run again goes back through the saved command, not a typed copy of its prelude.
		expect(screen.getByRole('button', { name: /Run again/ }).query()).toBeNull();
	});
});

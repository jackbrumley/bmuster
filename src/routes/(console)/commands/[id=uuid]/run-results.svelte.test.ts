import { beforeEach, describe, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';
import {
	emptyCounts,
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
		const screen = await render(RunResults, { initial: view(machines), now: NOW });
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
			now: NOW
		});
		await expect.element(screen.getByText('2 succeeded')).toBeVisible();
		expect(
			screen.getByRole('button', { name: 'Run again on failed and offline' }).query()
		).toBeNull();
	});

	it('C16: rows update live from the run’s events', async () => {
		const screen = await render(RunResults, {
			initial: view([row(1, 'running', null), row(2, 'waiting', null)], 'running'),
			now: NOW
		});
		await expect.element(screen.getByText('1 waiting · 1 running')).toBeVisible();
		await expect.element(screen.getByRole('button', { name: 'Cancel run' })).toBeVisible();
		await expect.poll(() => FakeEventSource.opened.length).toBe(1);
		feed().send(COMMAND_RUN_EVENT, view([row(1, 'succeeded', 0), row(2, 'failed', 2)]));
		await expect.element(screen.getByText('1 succeeded · 1 failed')).toBeVisible();
		expect(screen.getByRole('button', { name: 'Cancel run' }).query()).toBeNull();
	});
});

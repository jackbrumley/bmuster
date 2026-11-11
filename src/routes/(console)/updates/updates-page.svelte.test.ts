import { CHANGELOG } from '#lib/domain/releases/changelog.ts';
import { describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import ConfirmDialog from '#lib/ui/confirm-dialog.svelte';
import UpdatesPage from './+page.svelte';
import { reloadPage } from './reload-page.ts';
import type { PageData } from './$types';

const refreshAll = vi.hoisted(() => vi.fn(() => Promise.resolve()));
vi.mock('$app/navigation', () => ({ refreshAll }));
vi.mock('./reload-page.ts', () => ({ reloadPage: vi.fn() }));

type Data = PageData;

const NOW = Date.parse('2026-11-07T12:00:00.000Z');
const ROLLOUT: Extract<Data['rollout'], { kind: 'rollout' }> = {
	kind: 'rollout',
	version: '0.2.0',
	stage: 'early',
	startedIso: '2026-11-07T11:30:00.000Z',
	stageStartedIso: '2026-11-07T11:30:00.000Z',
	paused: { kind: 'running' }
};

function machine(id: string, name: string, update: Data['machines'][number]['update']) {
	return {
		id,
		name,
		osFamily: 'linux' as const,
		agentVersion: '0.1.0',
		status: { kind: 'online' as const },
		update,
		channel: 'full' as const
	};
}

const EARLY_GROUP: Data['earlyGroup'] = {
	id: '00000000-0000-4000-8000-0000000ea51e',
	name: 'Early updates',
	machines: 2
};

const TEST_CHANNEL: Data['testChannel'] = {
	group: { id: '00000000-0000-4000-8000-000000007e57', name: 'Test', machines: 0 },
	build: { kind: 'none' },
	check: { checkedAtIso: null, problem: null }
};

const MACHINES: Data['machines'] = [
	machine('11111111-1111-4111-8111-111111111111', 'Current', { kind: 'up-to-date' }),
	machine('22222222-2222-4222-8222-222222222222', 'Behind', {
		kind: 'available',
		version: '0.2.0',
		needsReinstall: false
	}),
	machine('33333333-3333-4333-8333-333333333333', 'Old install', {
		kind: 'available',
		version: '0.2.0',
		needsReinstall: true
	}),
	machine('44444444-4444-4444-8444-444444444444', 'Failed', {
		kind: 'rolled-back',
		version: '0.2.0',
		reason: 'version 0.2.0 did not check in within 120 s'
	})
];

const IDLE: Data['server']['operation'] = {
	phase: 'idle',
	from: null,
	to: null,
	message: '',
	atIso: null
};

const SERVER_RELEASE: Data['server'] = {
	installedVersion: '0.3.1',
	deployment: 'installed',
	checkedAtIso: '2026-11-08T10:00:00.000Z',
	lastSuccessAtIso: '2026-11-08T10:00:00.000Z',
	release: {
		version: '0.3.2',
		notes: 'Server update reliability.',
		publishedAtIso: '2026-11-08T10:00:00.000Z',
		manifest: {
			schemaVersion: 1,
			version: '0.3.2',
			target: 'x86_64-unknown-linux-gnu',
			archive: 'bmuster-app-x86_64-unknown-linux-gnu.tar.gz',
			bytes: 100,
			sha256: 'a'.repeat(64),
			minimumLauncher: '0.3.0',
			nodeMajor: 26,
			rollbackFrom: ['0.3.0', '0.3.1']
		}
	},
	problem: null,
	install: { allowed: true, reason: '' },
	operation: IDLE
};

function renderPage(overrides: Partial<Data>) {
	return render(UpdatesPage, {
		params: {},
		form: undefined,
		data: {
			user: { id: 'a', name: 'Ada', email: 'ada@example.com', role: 'admin' },
			localNetworkMode: false,
			serverUpdate: null,
			signedIn: true,
			now: NOW,
			server: {
				installedVersion: '0.3.0',
				deployment: 'source',
				checkedAtIso: null,
				lastSuccessAtIso: null,
				release: null,
				problem: null,
				install: { allowed: false, reason: 'Source run' },
				operation: IDLE
			},
			policy: 'automatic',
			rollout: ROLLOUT,
			earlyGroup: EARLY_GROUP,
			testChannel: TEST_CHANNEL,
			builds: [
				{ version: '0.2.0', target: 'x86_64-unknown-linux-gnu', signed: true },
				{ version: '0.1.0', target: 'x86_64-unknown-linux-gnu', signed: false }
			],
			machines: MACHINES,
			...overrides
		}
	});
}

/** Serves Update now, then the update view as the root updater reports each step. */
function serveUpdate(views: Data['server'][]) {
	const queue = [...views];
	const fetch = vi.fn<typeof globalThis.fetch>((input, init) => {
		const json = (body: unknown, status: number) =>
			Promise.resolve(
				new Response(JSON.stringify(body), {
					status,
					headers: { 'content-type': 'application/json' }
				})
			);
		if (input === '/api/server-updates/install' && init?.method === 'POST') {
			return json({ requestedAtIso: '2026-11-08T10:05:00.000Z', view: SERVER_RELEASE }, 202);
		}
		if (input === '/api/server-updates' && init?.method === 'GET') {
			const next = queue.length > 1 ? queue.shift() : queue[0];
			return json(next, 200);
		}
		return json({}, 200);
	});
	vi.stubGlobal('fetch', fetch);
	return fetch;
}

function step(
	phase: Data['server']['operation']['phase'],
	message: string,
	installedVersion = '0.3.1'
): Data['server'] {
	return {
		...SERVER_RELEASE,
		installedVersion,
		operation: { phase, from: '0.3.1', to: '0.3.2', message, atIso: '2026-11-08T10:05:30.000Z' }
	};
}

async function startUpdate(screen: Awaited<ReturnType<typeof renderPage>>): Promise<void> {
	await screen
		.getByRole('region', { name: 'Server' })
		.getByRole('button', { name: 'Update now' })
		.click();
	const dialog = screen.getByRole('dialog', { name: 'Update BMuster to 0.3.2?' });
	await dialog.getByRole('button', { name: 'Update now' }).click();
}

describe('Updates page (SPEC-AGENT-UPDATES)', () => {
	it('shows the version on offer, the stage, the builds and every machine, failures first', async () => {
		const screen = await renderPage({});
		await expect.element(screen.getByText('Version 0.2.0')).toBeVisible();
		await expect.element(screen.getByText(/Early updates group, since/)).toBeVisible();
		await expect
			.element(screen.getByText('1 up to date · 2 behind · 1 failed · 0 pinned'))
			.toBeVisible();
		await expect.element(screen.getByText('Not signed: install only')).toBeVisible();
		const names = screen
			.getByRole('list', { name: /Machines and their agent versions/ })
			.getByRole('link')
			.elements()
			.map((link) => link.textContent);
		expect(names).toEqual(['Failed', 'Behind', 'Old install', 'Current']);
		await expect.element(screen.getByText('Rolled back')).toBeVisible();
		await expect.element(screen.getByRole('button', { name: 'Pause roll-out' })).toBeVisible();
	});

	it('offers Update now only for machines that can take it, and sends the selection', async () => {
		const fetch = vi.fn<typeof globalThis.fetch>(() =>
			Promise.resolve(
				new Response(JSON.stringify({ requested: 1, skipped: [] }), {
					status: 200,
					headers: { 'content-type': 'application/json' }
				})
			)
		);
		vi.stubGlobal('fetch', fetch);
		await render(ConfirmDialog);
		const screen = await renderPage({});
		// Behind and Failed can update; Old install needs a reinstall; Current is up to date.
		expect(screen.getByRole('checkbox').all()).toHaveLength(2);
		await screen.getByRole('checkbox', { name: 'Select Behind' }).click();
		await screen.getByRole('button', { name: 'Update 1 selected' }).click();
		await screen.getByRole('button', { name: 'Update now' }).click();
		await vi.waitFor(() => {
			expect(fetch).toHaveBeenCalledOnce();
		});
		const [url, init] = fetch.mock.calls[0] ?? [];
		expect(url).toBe('/api/agent-updates/update-now');
		expect(JSON.parse(typeof init?.body === 'string' ? init.body : '')).toEqual({
			machines: { kind: 'some', ids: ['22222222-2222-4222-8222-222222222222'] }
		});
	});

	it('says plainly when a failure paused the roll-out, and offers Resume', async () => {
		const screen = await renderPage({
			rollout: {
				...ROLLOUT,
				paused: {
					kind: 'paused',
					reason: 'Failed rolled back 0.2.0: no check-in',
					atIso: '2026-11-07T11:50:00.000Z',
					by: 'system'
				}
			}
		});
		await expect
			.element(screen.getByRole('alert').getByText('The roll-out of 0.2.0 is paused'))
			.toBeVisible();
		await expect.element(screen.getByText(/Failed rolled back 0.2.0: no check-in/)).toBeVisible();
		await expect.element(screen.getByRole('button', { name: 'Resume roll-out' })).toBeVisible();
	});

	it('explains that nothing can be offered without a signed build', async () => {
		const screen = await renderPage({ rollout: { kind: 'none' }, builds: [] });
		await expect.element(screen.getByText(/no signed agent build yet/)).toBeVisible();
	});

	it('shows an inconclusive latest-release state after a failed check', async () => {
		const screen = await renderPage({
			server: {
				installedVersion: '0.3.0',
				deployment: 'installed',
				checkedAtIso: '2026-11-08T09:19:25.000Z',
				lastSuccessAtIso: '2026-11-08T09:13:52.000Z',
				release: null,
				problem: 'Update check returned HTTP 504.',
				install: {
					allowed: false,
					reason:
						'Could not confirm whether a newer signed release is available. Check for updates again.'
				},
				operation: IDLE
			}
		});
		await expect
			.element(screen.getByText('Latest signed release: Unable to confirm'))
			.toBeVisible();
		await expect.element(screen.getByText('Update check returned HTTP 504.')).toBeVisible();
		await expect.element(screen.getByText('No newer release found')).not.toBeInTheDocument();
	});

	it('keeps the update page loaded through temporary proxy failures', async () => {
		const fetch = vi.fn<typeof globalThis.fetch>((input, init) => {
			if (input === '/api/server-updates/install' && init?.method === 'POST') {
				return Promise.resolve(
					new Response(
						JSON.stringify({ requestedAtIso: '2026-11-08T10:05:00.000Z', view: SERVER_RELEASE }),
						{
							status: 202,
							headers: { 'content-type': 'application/json' }
						}
					)
				);
			}
			if (input === '/api/server-updates' && init?.method === 'GET') {
				return Promise.resolve(new Response('host not found', { status: 502 }));
			}
			return Promise.resolve(new Response('{}', { status: 200 }));
		});
		vi.stubGlobal('fetch', fetch);
		await render(ConfirmDialog);
		const screen = await renderPage({ server: SERVER_RELEASE });

		await screen.getByRole('button', { name: 'Update now' }).click();
		const dialog = screen.getByRole('dialog', { name: 'Update BMuster to 0.3.2?' });
		await dialog.getByRole('button', { name: 'Update now' }).click();

		// SU14: what is happening, a countdown, that the page reloads itself, and the step.
		await expect.element(screen.getByRole('status')).toBeVisible();
		await expect
			.element(screen.getByRole('status').getByText('BMuster is updating to 0.3.2. Please wait.'))
			.toBeVisible();
		const detail = screen.getByRole('status').getByText(/seconds left/);
		await expect.element(detail).toBeVisible();
		await vi.waitFor(() => {
			const text = detail.element().textContent;
			expect(text).toContain('This page reloads by itself when BMuster is back');
			expect(text).toContain('Waiting for the server to come back');
		});
		await expect
			.element(screen.getByRole('heading', { name: 'Server', exact: true }))
			.not.toBeInTheDocument();
		await expect.element(screen.getByText('Reconnecting automatically')).not.toBeInTheDocument();
		await expect.element(screen.getByRole('heading', { name: 'Roll-out' })).not.toBeInTheDocument();
		await vi.waitFor(() => {
			expect(fetch.mock.calls.some(([url]) => url === '/api/server-updates')).toBe(true);
		});
	});

	it("SU9: shows the root updater's progress and says what happens if the new version fails", async () => {
		await render(ConfirmDialog);
		const screen = await renderPage({
			server: {
				...SERVER_RELEASE,
				install: { allowed: false, reason: 'A server update is already in progress.' },
				operation: {
					phase: 'downloading',
					from: '0.3.1',
					to: '0.3.2',
					message: 'Downloading and checking BMuster 0.3.2',
					atIso: '2026-11-08T10:05:00.000Z'
				}
			}
		});
		await expect.element(screen.getByText('Server update: downloading')).toBeVisible();
		await expect.element(screen.getByText('Downloading and checking BMuster 0.3.2')).toBeVisible();
		await expect.element(screen.getByText('A server update is already in progress.')).toBeVisible();
		await expect
			.element(screen.getByRole('button', { name: 'Update now' }))
			.not.toBeInTheDocument();
	});

	it('SU9: the confirmation names automatic rollback only when the release declares it', async () => {
		await render(ConfirmDialog);
		const screen = await renderPage({
			server: {
				...SERVER_RELEASE,
				release:
					SERVER_RELEASE.release === null
						? null
						: {
								...SERVER_RELEASE.release,
								manifest: { ...SERVER_RELEASE.release.manifest, rollbackFrom: [] }
							}
			}
		});
		await screen.getByRole('button', { name: 'Update now' }).click();
		const dialog = screen.getByRole('dialog', { name: 'Update BMuster to 0.3.2?' });
		await expect
			.element(dialog.getByText(/the server stays stopped for an administrator/))
			.toBeVisible();
		await expect
			.element(dialog.getByText(/including Node|launcher, Node and the console/))
			.toBeVisible();
		await dialog.getByRole('button', { name: 'Cancel' }).click();
	});

	it('U8: links to the built-in Early updates group, inviting a first machine when it is empty', async () => {
		const screen = await renderPage({ earlyGroup: { ...EARLY_GROUP, machines: 0 } });
		await expect
			.element(screen.getByText(/Machines in Early updates get new versions first\. 0 machines/))
			.toBeVisible();
		await expect
			.element(screen.getByRole('link', { name: 'add one' }))
			.toHaveAttribute('href', '/groups?machineGroup=00000000-0000-4000-8000-0000000ea51e');
	});

	it('U8: counts the Early updates machines and offers to add or take out', async () => {
		const screen = await renderPage({ earlyGroup: { ...EARLY_GROUP, machines: 1 } });
		await expect.element(screen.getByText(/get new versions first\. 1 machine —/)).toBeVisible();
		await expect.element(screen.getByRole('link', { name: 'add or take out' })).toBeVisible();
	});

	it('U8: shows the Early updates line before there is any signed build', async () => {
		const screen = await renderPage({ rollout: { kind: 'none' }, builds: [] });
		await expect
			.element(screen.getByText(/Machines in Early updates get new versions first/))
			.toBeVisible();
	});

	it('T8: shows the test build on offer, which machines run it, and each machine’s channel', async () => {
		const screen = await renderPage({
			testChannel: {
				group: { ...TEST_CHANNEL.group, machines: 1 },
				build: {
					kind: 'build',
					version: '0.2.1-test.1',
					machines: [{ id: '55555555-5555-4555-8555-555555555555', name: 'Fedora laptop' }]
				},
				check: { checkedAtIso: '2026-11-07T11:00:00.000Z', problem: null }
			},
			machines: [
				{
					...machine('55555555-5555-4555-8555-555555555555', 'Fedora laptop', {
						kind: 'up-to-date'
					}),
					agentVersion: '0.2.1-test.1',
					channel: 'test'
				},
				machine('11111111-1111-4111-8111-111111111111', 'Office', { kind: 'up-to-date' })
			]
		});
		const panel = screen.getByRole('region', { name: 'Test channel' });
		await expect.element(panel.getByText('Test build 0.2.1-test.1')).toBeVisible();
		await expect.element(panel.getByText('Fedora laptop')).toBeVisible();
		await expect.element(panel.getByText(/1 machine —/)).toBeVisible();
		await expect.element(panel.getByText(/^Looked on GitHub /)).toBeVisible();
		await expect
			.element(panel.getByRole('link', { name: 'open the Test group' }))
			.toHaveAttribute('href', '/groups?machineGroup=00000000-0000-4000-8000-000000007e57');
		await expect
			.element(screen.getByText(/Version 0\.2\.1-test\.1 · Test channel · online/))
			.toBeVisible();
		await expect
			.element(screen.getByText(/Version 0\.1\.0 · Full releases · online/))
			.toBeVisible();
	});

	it('T8: says when there is no test build, and shows why the last look failed', async () => {
		const screen = await renderPage({
			testChannel: {
				...TEST_CHANNEL,
				check: {
					checkedAtIso: '2026-11-07T11:58:00.000Z',
					problem: 'Update check returned HTTP 503.'
				}
			}
		});
		const panel = screen.getByRole('region', { name: 'Test channel' });
		await expect.element(panel.getByText(/No test build on offer/)).toBeVisible();
		await expect.element(panel.getByText(/0 machines —/)).toBeVisible();
		const alert = panel.getByRole('alert');
		await expect.element(alert.getByText('The last look for test builds failed')).toBeVisible();
		await expect.element(alert.getByText(/HTTP 503\. \(2 min ago\)/)).toBeVisible();
	});

	it("L3: shows the update wait with the updater's step, and lifts it when it rolls back", async () => {
		serveUpdate([
			step('downloading', 'Downloading and checking BMuster 0.3.2'),
			step('rolled-back', 'BMuster 0.3.2 did not start; 0.3.1 is back')
		]);
		await render(ConfirmDialog);
		const screen = await renderPage({ server: SERVER_RELEASE });
		await startUpdate(screen);
		const veil = screen.getByRole('status');
		await expect
			.element(veil.getByText('BMuster is updating to 0.3.2. Please wait.'))
			.toBeVisible();
		await expect.element(veil.getByText(/Downloading and checking BMuster 0\.3\.2/)).toBeVisible();
		// Nothing else shows while it updates: no server panel, release notes or roll-out.
		await expect
			.element(screen.getByRole('heading', { name: 'Server', exact: true }))
			.not.toBeInTheDocument();
		await expect
			.element(screen.getByRole('heading', { name: 'Release notes' }))
			.not.toBeInTheDocument();
		await vi.waitFor(() => {
			expect(refreshAll).toHaveBeenCalled();
		}, 5000);
		await expect
			.element(screen.getByText('BMuster is updating to 0.3.2. Please wait.'))
			.not.toBeInTheDocument();
		await expect.element(screen.getByRole('heading', { name: 'Roll-out' })).toBeVisible();
		expect(reloadPage).not.toHaveBeenCalled();
	});

	it('L3: lifts the veil and loads the new console when the new version is healthy', async () => {
		serveUpdate([
			step('starting', 'Starting BMuster 0.3.2'),
			step('healthy', 'BMuster 0.3.2 is running', '0.3.2')
		]);
		await render(ConfirmDialog);
		const screen = await renderPage({ server: SERVER_RELEASE });
		await startUpdate(screen);
		await expect
			.element(screen.getByRole('status').getByText(/Starting BMuster 0\.3\.2/))
			.toBeInTheDocument();
		await vi.waitFor(() => {
			expect(reloadPage).toHaveBeenCalledOnce();
		}, 5000);
		await expect
			.element(screen.getByText('BMuster is updating to 0.3.2. Please wait.'))
			.not.toBeInTheDocument();
	});

	it('shows the newest release notes and folds the earlier versions away', async () => {
		const [latest, previous] = CHANGELOG;
		const screen = await renderPage({});
		await expect
			.element(screen.getByRole('heading', { name: `BMuster ${latest.version}`, exact: true }))
			.toBeVisible();
		// Folded away, the older notes are not in the accessibility tree, so find them by text.
		const older = screen.getByText(`BMuster ${previous.version}`, { exact: true });
		await expect.element(older).not.toBeVisible();
		await screen.getByText(`Earlier versions (${String(CHANGELOG.length - 1)})`).click();
		await expect.element(older).toBeVisible();
	});

	it('L4: Check for updates shows a small radar in the button while it checks', async () => {
		let answer: (response: Response) => void = () => undefined;
		vi.stubGlobal(
			'fetch',
			vi.fn<typeof globalThis.fetch>(
				() =>
					new Promise<Response>((resolve) => {
						answer = resolve;
					})
			)
		);
		const screen = await renderPage({ server: SERVER_RELEASE });
		await screen.getByRole('button', { name: 'Check for updates' }).click();
		const busy = screen.getByRole('button', { name: 'Checking for updates' });
		await expect.element(busy).toBeVisible();
		expect(busy.element().querySelector('[data-radar="small"]')).not.toBeNull();
		answer(
			new Response(JSON.stringify(SERVER_RELEASE), {
				status: 200,
				headers: { 'content-type': 'application/json' }
			})
		);
		await expect.element(screen.getByRole('button', { name: 'Check for updates' })).toBeVisible();
	});
});

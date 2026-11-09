import { describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import ConfirmDialog from '#lib/ui/confirm-dialog.svelte';
import UpdatesPage from './+page.svelte';
import type { PageData } from './$types';

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
		update
	};
}

const EARLY_GROUP: Data['earlyGroup'] = {
	id: '00000000-0000-4000-8000-0000000ea51e',
	name: 'Early updates',
	machines: 2
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
			builds: [
				{ version: '0.2.0', target: 'x86_64-unknown-linux-gnu', signed: true },
				{ version: '0.1.0', target: 'x86_64-unknown-linux-gnu', signed: false }
			],
			machines: MACHINES,
			...overrides
		}
	});
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

		await expect
			.element(screen.getByRole('heading', { name: 'Updating BMuster server' }))
			.toBeVisible();
		await expect.element(screen.getByText('Reconnecting automatically')).toBeVisible();
		await expect.element(screen.getByText(/host-not-found error/)).toBeVisible();
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
});

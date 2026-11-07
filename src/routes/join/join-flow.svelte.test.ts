import { describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import JoinPage from './+page.svelte';

function stubJoin() {
	const paths: string[] = [];
	let connected = false;
	vi.stubGlobal(
		'fetch',
		vi.fn((url: string) => {
			paths.push(url);
			if (url === '/join/install') {
				return Promise.resolve(
					Response.json({
						linux: { kind: 'ready', command: 'sudo install-test --code ABC-DEF-GHJ' },
						windows: { kind: 'none' }
					})
				);
			}
			if (url === '/join/stop') return Promise.resolve(Response.json({ recorded: true }));
			return Promise.resolve(
				Response.json(
					connected
						? { kind: 'connected', supportPerson: 'Ada Support' }
						: {
								kind: 'open',
								supportPerson: 'Ada Support',
								organisation: 'Example IT',
								expiresAtIso: '2026-11-08T12:00:00.000Z',
								scamWording: {
									impersonators: 'your bank',
									reportAdvice: 'Hang up and call your IT department.'
								}
							}
				)
			);
		})
	);
	return {
		paths,
		connect: () => {
			connected = true;
		}
	};
}

async function enterCode() {
	const screen = await render(JoinPage, {
		data: { organisation: 'Example IT', signedIn: false },
		params: {},
		form: null
	});
	await screen.getByRole('textbox', { name: 'Support code' }).fill('123456');
	await expect
		.element(screen.getByRole('textbox', { name: 'Support code' }))
		.toHaveValue('123\u2002456');
	await screen.getByRole('button', { name: 'Continue', exact: true }).click();
	await expect.element(screen.getByText('Ada Support', { exact: true })).toBeVisible();
	return screen;
}

describe('phone support journey (SPEC-JOIN J6–J10)', () => {
	it('shows who gets access and requires every safe answer before offering the command', async () => {
		const api = stubJoin();
		const screen = await enterCode();
		await expect.element(screen.getByText('Is this a scam?')).toBeVisible();
		expect(screen.container.querySelector('[aria-pressed="true"]')).toBeNull();
		expect(screen.container.textContent).not.toContain('sudo install-test');
		const groups = screen.container.querySelectorAll('[role="group"]');
		for (const group of groups) {
			const safe = group.querySelector('button');
			if (!(safe instanceof HTMLButtonElement)) throw new Error('Missing answer');
			safe.click();
		}
		await screen.getByRole('button', { name: 'Continue', exact: true }).click();
		await expect.element(screen.getByText('sudo install-test --code ABC-DEF-GHJ')).toBeVisible();
		expect(api.paths).toContain('/join/install');
		expect(screen.container.textContent).not.toContain('Windows PowerShell');
		api.connect();
		await expect
			.element(screen.getByText('Ada Support can now help you.', { exact: false }))
			.toBeVisible();
	});

	it('stops an unsafe answer, reports it, and clears answers on going back', async () => {
		const api = stubJoin();
		const screen = await enterCode();
		const unsafe = screen.container.querySelectorAll('[role="group"] button')[1];
		if (!(unsafe instanceof HTMLButtonElement)) throw new Error('Missing answer');
		unsafe.click();
		await expect
			.element(screen.getByRole('heading', { name: 'Stop. This looks like a scam.' }))
			.toBeVisible();
		expect(api.paths).toContain('/join/stop');
		expect(api.paths).not.toContain('/join/install');
		await screen.getByRole('button', { name: 'Go back' }).click();
		expect(screen.container.querySelector('[aria-pressed="true"]')).toBeNull();
	});
});

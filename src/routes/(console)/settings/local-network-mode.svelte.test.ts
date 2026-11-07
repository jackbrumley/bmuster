import { describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import type { LocalTlsStatus } from '#lib/domain/settings/local-tls.ts';
import ConfirmDialog from '#lib/ui/confirm-dialog.svelte';
import LocalNetworkMode from './local-network-mode.svelte';

const OFF: LocalTlsStatus = { on: false, restartNeeded: false, served: { kind: 'none' } };
const PIN = `sha256:${'B'.repeat(43)}=`;
const ON: LocalTlsStatus = {
	on: true,
	restartNeeded: false,
	served: { kind: 'pin', pin: PIN, fingerprint: 'AB:CD' }
};

async function renderSetting(localTls: LocalTlsStatus) {
	const save = vi.fn((_on: boolean) => Promise.resolve());
	const renew = vi.fn(() => Promise.resolve());
	await render(ConfirmDialog);
	const screen = await render(LocalNetworkMode, { localTls, save, renew });
	return { screen, save, renew };
}

describe('Local network mode setting', () => {
	it('L2: turning it on explains the four points and needs “I understand” ticked', async () => {
		const { screen, save } = await renderSetting(OFF);
		await screen.getByRole('button', { name: 'On' }).click();
		const dialog = screen.getByRole('dialog', { name: 'Turn on local network mode?' });
		await expect.element(dialog).toBeVisible();
		await expect
			.element(dialog.getByText(/serves HTTPS itself, with a certificate it makes/))
			.toBeVisible();
		await expect
			.element(dialog.getByText(/Browsers warn about that certificate the first time/))
			.toBeVisible();
		await expect
			.element(dialog.getByText(/only on a network you control. Never expose/))
			.toBeVisible();
		await expect
			.element(dialog.getByText(/Agents trust only this server's certificate/))
			.toBeVisible();

		await dialog.getByRole('button', { name: 'Turn on' }).click();
		await expect.element(dialog.getByText('Tick “I understand” to turn it on.')).toBeVisible();
		expect(save).not.toHaveBeenCalled();

		await dialog.getByRole('checkbox', { name: 'I understand' }).click();
		await dialog.getByRole('button', { name: 'Turn on' }).click();
		expect(save).toHaveBeenCalledExactlyOnceWith(true);
	});

	it('L2: cancelling the dialog changes nothing', async () => {
		const { screen, save } = await renderSetting(OFF);
		await screen.getByRole('button', { name: 'On' }).click();
		const dialog = screen.getByRole('dialog', { name: 'Turn on local network mode?' });
		await dialog.getByRole('checkbox', { name: 'I understand' }).click();
		await dialog.getByRole('button', { name: 'Cancel' }).click();
		await expect.element(dialog).not.toBeInTheDocument();
		expect(save).not.toHaveBeenCalled();
	});

	it('L2: turning it off is confirmed first', async () => {
		const { screen, save } = await renderSetting(ON);
		await screen.getByRole('button', { name: 'Off' }).click();
		await expect.element(screen.getByText('Turn off local network mode?')).toBeVisible();
		await screen.getByRole('button', { name: 'Cancel' }).click();
		expect(save).not.toHaveBeenCalled();

		await screen.getByRole('button', { name: 'Off' }).click();
		await screen.getByRole('button', { name: 'Turn off' }).click();
		expect(save).toHaveBeenCalledExactlyOnceWith(false);
	});

	it('L4: says to restart, and shows the certificate it serves', async () => {
		const { screen } = await renderSetting({ ...ON, restartNeeded: true });
		await expect.element(screen.getByText('Restart BMuster to apply.')).toBeVisible();
		await expect.element(screen.getByText(PIN)).toBeVisible();
		await expect.element(screen.getByText('AB:CD')).toBeVisible();
	});

	it('L7: a new certificate is made only after confirming', async () => {
		const { screen, renew } = await renderSetting(ON);
		await screen.getByRole('button', { name: 'Make a new certificate' }).click();
		await screen.getByRole('button', { name: 'Cancel' }).click();
		expect(renew).not.toHaveBeenCalled();
		await screen.getByRole('button', { name: 'Make a new certificate' }).click();
		await screen
			.getByRole('dialog')
			.getByRole('button', { name: 'Make a new certificate' })
			.click();
		expect(renew).toHaveBeenCalledOnce();
	});
});

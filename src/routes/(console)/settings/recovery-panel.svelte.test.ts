import { describe, expect, it } from 'vitest';
import { render } from 'vitest-browser-svelte';
import type { RecoveryFacts } from '#lib/domain/settings/recovery.ts';
import RecoveryPanel from './recovery-panel.svelte';

const LINUX: RecoveryFacts = {
	deployment: 'linux',
	secrets: { kind: 'settings-file', path: '/var/lib/bmuster-server/server.env' },
	snapshots: { kind: 'daily', folder: '/var/lib/bmuster-server/backups', keep: 14 },
	commands: {
		resetPassword:
			'sudo /opt/bmuster-server/current/bmuster-server reset-password --email ada@example.com',
		resetTwoFactor:
			'sudo /opt/bmuster-server/current/bmuster-server reset-two-factor --email ada@example.com'
	}
};

describe('the Recovery panel in Settings (SPEC-SERVER-INSTALL I17)', () => {
	it('I17: names what to back up with its real paths, the two host commands, disk encryption and the FAQ', async () => {
		const screen = await render(RecoveryPanel, { facts: LINUX });
		await expect.element(screen.getByRole('heading', { name: 'Recovery' })).toBeVisible();
		await expect.element(screen.getByText('/var/lib/bmuster-server/server.env')).toBeVisible();
		await expect.element(screen.getByText(/SECRETS_KEY/).first()).toBeVisible();
		await expect.element(screen.getByText('/var/lib/bmuster-server/backups')).toBeVisible();
		await expect.element(screen.getByText(/14 days/)).toBeVisible();
		await expect.element(screen.getByText(LINUX.commands.resetPassword)).toBeVisible();
		await expect.element(screen.getByText(LINUX.commands.resetTwoFactor)).toBeVisible();
		await expect.element(screen.getByText(/disk encryption/)).toBeVisible();
		const faq = screen.getByRole('link', { name: /questions and answers/ });
		expect(faq.element().getAttribute('href')).toBe('https://bmuster.com/faq#getting-back-in');
	});

	it('I17: in a container the key is a container variable, and snapshots that are off say so', async () => {
		const screen = await render(RecoveryPanel, {
			facts: {
				deployment: 'docker',
				secrets: { kind: 'container-variable' },
				snapshots: { kind: 'off', folder: '/data/backups' },
				commands: {
					resetPassword: 'docker exec <container> bmuster-server reset-password --email a@b.c',
					resetTwoFactor: 'docker exec <container> bmuster-server reset-two-factor --email a@b.c'
				}
			}
		});
		await expect.element(screen.getByText(/container's SECRETS_KEY variable/)).toBeVisible();
		await expect.element(screen.getByText(/Nightly snapshots are off/)).toBeVisible();
		await expect.element(screen.getByText(/docker exec <container>/).first()).toBeVisible();
	});
});

import { describe, expect, it } from 'vitest';
import { render } from 'vitest-browser-svelte';
import ReleaseNotes from './release-notes.svelte';

const HEADING = 'What to test on real machines';

describe('release notes on the Updates page (SPEC-RELEASE-NOTES)', () => {
	it('R4: shows what to test on real machines under the changes when the release lists it', async () => {
		const screen = await render(ReleaseNotes, {
			release: {
				version: '9.1.0',
				testing: { kind: 'steps', steps: ['On an Android phone, pinch to zoom the desktop'] },
				changes: ['Pinch to zoom on phones']
			}
		});
		await expect.element(screen.getByRole('heading', { name: 'BMuster 9.1.0' })).toBeVisible();
		await expect.element(screen.getByText('Pinch to zoom on phones')).toBeVisible();
		await expect.element(screen.getByRole('heading', { name: HEADING })).toBeVisible();
		await expect
			.element(screen.getByText('On an Android phone, pinch to zoom the desktop'))
			.toBeVisible();
	});

	it('R4: leaves the section out when the release lists nothing to test', async () => {
		const screen = await render(ReleaseNotes, {
			release: { version: '9.0.0', testing: { kind: 'none' }, changes: ['A fix nobody can see'] }
		});
		await expect.element(screen.getByText('A fix nobody can see')).toBeVisible();
		await expect.element(screen.getByRole('heading', { name: HEADING })).not.toBeInTheDocument();
	});
});

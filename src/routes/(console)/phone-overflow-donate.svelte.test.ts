import '../../app.css';
import { afterEach, beforeEach, describe, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import type { DonateWording } from '#lib/domain/settings/donate-reminder.ts';
import { MACHINES, NOW } from '#tests/helpers/long-data.ts';
import MachinesPage from './+page.svelte';
import {
	CONSOLE,
	checkPhoneWidth,
	IN_CONSOLE,
	stubPhoneServer,
	type PhonePage
} from './phone-overflow-harness.ts';

/**
 * SPEC-DONATE D9 (SPEC-PHONE-LAYOUT U1): the donation reminder at the bottom of the Machines page
 * fits a 360 px phone with every wording, in light and dark themes. Kept apart from
 * phone-overflow.svelte.test.ts, which is at its size limit; the setup is the same harness.
 */

vi.mock('$app/navigation', () => ({ refreshAll: () => Promise.resolve(), goto: vi.fn() }));
vi.mock('$app/state', () => ({
	page: {
		url: new URL('https://bmuster.example-company.com.au/'),
		route: { id: '/(console)' },
		params: {},
		status: 200,
		error: null
	}
}));

const READY: Record<DonateWording, string> = {
	first: 'please consider a small donation',
	again: 'please consider giving back',
	thanks: 'Still finding it useful?'
};

const PAGES: PhonePage[] = (['first', 'again', 'thanks'] as const).map((wording) => ({
	name: `D9: Machines with the donation reminder (${wording})`,
	ready: READY[wording],
	open: () =>
		render(
			MachinesPage,
			{
				params: {},
				form: undefined,
				data: {
					...CONSOLE,
					now: NOW,
					rollout: { kind: 'none' },
					view: { kind: 'machines', machines: MACHINES },
					commands: { kind: 'none' },
					donate: { kind: 'shown', wording }
				}
			},
			IN_CONSOLE
		)
}));

beforeEach(stubPhoneServer);

checkPhoneWidth(PAGES);

describe('in the dark theme', () => {
	beforeEach(() => {
		document.documentElement.dataset['theme'] = 'dark';
	});
	afterEach(() => {
		delete document.documentElement.dataset['theme'];
	});
	checkPhoneWidth(PAGES);
});

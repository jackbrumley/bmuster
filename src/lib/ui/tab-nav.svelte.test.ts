import { describe, expect, it } from 'vitest';
import { page } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';
import { resolve } from '$app/paths';
import {
	IconChartDonut,
	IconDeviceDesktop,
	IconFolder,
	IconInfoCircle,
	IconNotes,
	IconSettings,
	IconTerminal2
} from '@tabler/icons-svelte-runes';
import TabNav from './tab-nav.svelte';

const params = { id: '11111111-1111-4111-8111-111111111111' };
const TABS = [
	{ href: resolve('/(console)/machines/[id]', params), label: 'Overview', icon: IconInfoCircle },
	{
		href: resolve('/(console)/machines/[id]/terminal', params),
		label: 'Terminal',
		icon: IconTerminal2
	},
	{
		href: resolve('/(console)/machines/[id]/desktop', params),
		label: 'Desktop',
		icon: IconDeviceDesktop
	},
	{ href: resolve('/(console)/machines/[id]/files', params), label: 'Files', icon: IconFolder },
	{
		href: resolve('/(console)/machines/[id]/storage', params),
		label: 'Storage',
		icon: IconChartDonut
	},
	{ href: resolve('/(console)/machines/[id]/notes', params), label: 'Notes', icon: IconNotes },
	{
		href: resolve('/(console)/machines/[id]/manage', params),
		label: 'Manage',
		icon: IconSettings
	}
];

function track(): Element | null {
	return document.querySelector('.scroll-track');
}

describe('TabNav', () => {
	it('shows a thin scroll bar when the tabs do not fit a phone', async () => {
		await page.viewport(390, 844);
		const screen = await render(TabNav, {
			label: 'Machine',
			tabs: TABS,
			current: TABS[0]?.href ?? ''
		});
		await expect.element(screen.getByRole('link', { name: 'Overview' })).toBeVisible();
		await expect.poll(track).not.toBeNull();
		expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(390);
	});

	it('shows no scroll bar when every tab fits', async () => {
		await page.viewport(1400, 900);
		const screen = await render(TabNav, {
			label: 'Machine',
			tabs: TABS,
			current: TABS[0]?.href ?? ''
		});
		await expect.element(screen.getByRole('link', { name: 'Manage' })).toBeVisible();
		expect(track()).toBeNull();
	});
});

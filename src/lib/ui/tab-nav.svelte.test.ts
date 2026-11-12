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
const ICONS = [
	IconInfoCircle,
	IconTerminal2,
	IconDeviceDesktop,
	IconFolder,
	IconChartDonut,
	IconNotes
];
/** Seven long tabs: too wide for a phone, room to spare on a wide screen. */
const TABS = [
	resolve('/(console)/machines/[id]', params),
	resolve('/(console)/machines/[id]/terminal', params),
	resolve('/(console)/machines/[id]/desktop', params),
	resolve('/(console)/machines/[id]/files', params),
	resolve('/(console)/machines/[id]/storage', params),
	resolve('/(console)/machines/[id]/notes', params),
	resolve('/(console)/machines/[id]/manage', params)
].map((href, index) => ({
	href,
	label: `Section ${index + 1}`,
	icon: ICONS[index % ICONS.length] ?? IconSettings
}));

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
		await expect.element(screen.getByRole('link', { name: 'Section 1' })).toBeVisible();
		await expect.poll(track).not.toBeNull();
		expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(390);
	});

	it('SPEC-MACHINE-DETAILS D15: brings the current tab into view by scrolling the row sideways, never the page', async () => {
		await page.viewport(390, 400);
		const spacer = document.createElement('div');
		spacer.style.height = '2000px';
		const screen = await render(TabNav, {
			label: 'Machine',
			tabs: TABS,
			current: TABS[0]?.href ?? ''
		});
		document.body.append(spacer);
		window.scrollTo(0, 600);
		const scrolledTo = window.scrollY;
		const row = screen.getByRole('navigation').element();
		expect(row.scrollLeft).toBe(0);
		await screen.rerender({ current: TABS[6]?.href ?? '' });
		await expect.poll(() => row.scrollLeft).toBeGreaterThan(0);
		expect(window.scrollY).toBe(scrolledTo);
		spacer.remove();
	});

	it('shows no scroll bar when every tab fits', async () => {
		await page.viewport(1400, 900);
		const screen = await render(TabNav, {
			label: 'Machine',
			tabs: TABS,
			current: TABS[0]?.href ?? ''
		});
		await expect.element(screen.getByRole('link', { name: 'Section 7' })).toBeVisible();
		expect(track()).toBeNull();
	});
});

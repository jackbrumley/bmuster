import { describe, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';
import ExportButton from './export-button.svelte';

describe('ExportButton (X1)', () => {
	it('is a secondary Export button that downloads its link without leaving the page', async () => {
		const clicked: { href: string; download: string }[] = [];
		vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
			this: HTMLAnchorElement
		) {
			clicked.push({ href: this.getAttribute('href') ?? '', download: this.download });
		});
		await render(ExportButton, { href: '/api/exports/users' });
		const button = page.getByRole('button', { name: 'Export' });
		await expect.element(button).toHaveAttribute('type', 'button');
		await expect.element(button).toHaveClass(/secondary/);
		await button.click();
		expect(clicked).toEqual([{ href: '/api/exports/users', download: '' }]);
	});
});

import { describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import RecoveryCodes from './recovery-codes.svelte';

const CODES = Array.from({ length: 10 }, (_, index) => `ABCD-EFGH-JKLM-NP${String(index + 20)}`);

describe('recovery codes, shown once (SPEC-TWO-FACTOR TF17)', () => {
	it('lists the codes and says to save them now', async () => {
		const screen = await render(RecoveryCodes, {
			codes: CODES,
			email: 'ada@example.com',
			origin: 'https://bmuster.example.com'
		});
		await expect.element(screen.getByText('Save these recovery codes now')).toBeVisible();
		expect(screen.getByRole('listitem').all()).toHaveLength(10);
		await expect.element(screen.getByText(CODES[0] ?? '')).toBeVisible();
	});

	it('copies them, and downloads them as bmuster-recovery-codes.txt', async () => {
		const clipboardWrite = vi.fn().mockResolvedValue(undefined);
		Object.defineProperty(navigator, 'clipboard', {
			configurable: true,
			value: { writeText: clipboardWrite }
		});
		const createObjectUrl = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:codes');
		vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
		const names: string[] = [];
		vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
			this: HTMLAnchorElement
		) {
			names.push(this.download);
		});

		const screen = await render(RecoveryCodes, {
			codes: CODES,
			email: 'ada@example.com',
			origin: 'https://bmuster.example.com'
		});
		await screen.getByRole('button', { name: 'Copy' }).click();
		await expect.poll(() => clipboardWrite.mock.calls.length).toBe(1);
		const copied = String(clipboardWrite.mock.calls[0]?.[0]);
		for (const code of CODES) {
			expect(copied).toContain(code);
		}
		expect(copied).toContain('ada@example.com');

		await screen.getByRole('button', { name: 'Download' }).click();
		await expect.poll(() => names).toEqual(['bmuster-recovery-codes.txt']);
		const file = createObjectUrl.mock.calls[0]?.[0];
		if (!(file instanceof Blob)) throw new Error('the download was not a Blob');
		await expect(file.text()).resolves.toContain(CODES[9] ?? '');
	});
});

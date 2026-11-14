import { beforeEach, describe, expect, it } from 'vitest';
import { page } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';
import { TEST_MACHINE } from '#tests/helpers/machines.ts';
import '#lib/ui/design-tokens.css';
import GuestPage from '../../../../s/[token]/guest-page.svelte';
import { CONTROL, renderTab, stubDesktopServer } from './desktop-test-harness.ts';
import DesktopWindow from './window/+page@.svelte';

// SPEC-SESSION-FILES: dropping files on a desktop page.

/** A drag carrying one file from the computer, as a file manager starts it. */
function fileDrag(type: 'dragover' | 'drop'): DragEvent {
	const transfer = new DataTransfer();
	transfer.items.add(new File(['pixels'], 'photo.png', { type: 'image/png' }));
	return new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: transfer });
}

/** Drags a file over `target` and drops it; true when the page kept the browser from opening it. */
function dropFileOn(target: Element): { over: boolean; drop: boolean } {
	const over = fileDrag('dragover');
	target.dispatchEvent(over);
	const drop = fileDrag('drop');
	target.dispatchEvent(drop);
	return { over: over.defaultPrevented, drop: drop.defaultPrevented };
}

beforeEach(async () => {
	await stubDesktopServer();
});

describe('a file dropped on a desktop page', () => {
	it('SF14: never navigates away from the Desktop tab, on the page or on the stage', async () => {
		const screen = await renderTab(CONTROL);
		await expect.element(screen.getByRole('button', { name: 'Connect' })).toBeVisible();
		expect(dropFileOn(document.body)).toEqual({ over: true, drop: true });
		expect(dropFileOn(screen.getByRole('button', { name: 'Connect' }).element())).toEqual({
			over: true,
			drop: true
		});
	});

	it('SF14: never navigates away from the pop-out window', async () => {
		const screen = await render(DesktopWindow, {
			form: undefined,
			params: { id: TEST_MACHINE.id },
			data: { signedIn: true, machine: TEST_MACHINE, grants: CONTROL }
		});
		const stage = screen.getByRole('application', { name: `Screen of ${TEST_MACHINE.name}` });
		await expect.element(stage).toBeInTheDocument();
		expect(dropFileOn(stage.element())).toEqual({ over: true, drop: true });
		expect(dropFileOn(document.body)).toEqual({ over: true, drop: true });
	});

	it('SF14: on a share link, never navigates away and says files cannot be sent', async () => {
		await render(GuestPage, {
			token: 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ',
			guest: {
				machineName: 'Front desk',
				osFamily: 'windows',
				recipient: 'Dave',
				sharedByName: 'Jack Brumley',
				permissions: ['desktop-view', 'desktop-control'],
				expiresIso: new Date(Date.now() + 30 * 60_000).toISOString()
			},
			loadedAtMs: Date.now()
		});
		await expect.element(page.getByRole('heading', { name: 'Front desk' })).toBeVisible();
		expect(dropFileOn(document.body)).toEqual({ over: true, drop: true });
		await expect.element(page.getByText("Files can't be sent through a share link.")).toBeVisible();
	});

	it('SF14: text dragged into a text box still lands there', async () => {
		const screen = await renderTab(CONTROL);
		await expect.element(screen.getByRole('button', { name: 'Connect' })).toBeVisible();
		const box = document.createElement('textarea');
		document.body.append(box);
		const transfer = new DataTransfer();
		transfer.setData('text/plain', 'hello');
		const over = new DragEvent('dragover', {
			bubbles: true,
			cancelable: true,
			dataTransfer: transfer
		});
		box.dispatchEvent(over);
		box.remove();
		expect(over.defaultPrevented).toBe(false);
	});
});

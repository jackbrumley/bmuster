import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Grant } from '#lib/domain/access/access.ts';
import { page } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';
import { TEST_MACHINE } from '#tests/helpers/machines.ts';
import '#lib/ui/design-tokens.css';
import GuestPage from '../../../../s/[token]/guest-page.svelte';
import { CONTROL, open, renderTab, stubDesktopServer } from './desktop-test-harness.ts';
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

const FILES: Grant[] = [...CONTROL, { permission: 'files', consent: 'unattended' }];

/** The session-files calls the page made, and a server that answers them. */
const asked: string[] = [];

function stubFilesServer(): void {
	asked.length = 0;
	vi.stubGlobal(
		'fetch',
		vi.fn((url: string) => {
			asked.push(url);
			if (url.includes('/session-files/destination')) {
				return Promise.resolve(
					Response.json({
						kind: 'ready',
						user: 'kim',
						folderLabel: 'Downloads/BMuster',
						free: 50 * 1024 ** 3
					})
				);
			}
			return Promise.resolve(
				Response.json({ sessionId: '33333333-3333-4333-8333-333333333333', browserTicket: 't-1' })
			);
		})
	);
}

function drag(
	target: Element,
	type: 'dragenter' | 'dragover' | 'dragleave' | 'drop',
	files: boolean
) {
	const transfer = new DataTransfer();
	if (files) {
		transfer.items.add(new File(['x'], 'a.txt'));
	} else {
		transfer.setData('text/plain', 'just text');
	}
	const event = new DragEvent(type, {
		bubbles: true,
		cancelable: true,
		dataTransfer: transfer,
		relatedTarget: type === 'dragleave' ? document.body : null
	});
	target.dispatchEvent(event);
	return event;
}

describe('the drop zone', () => {
	it('SF13: dragging files over the screen shows where they go; Escape and leaving close it; text does nothing', async () => {
		const { screen } = await open(FILES, 'Connect');
		stubFilesServer();
		const stage = screen
			.getByRole('application', { name: `Screen of ${TEST_MACHINE.name}` })
			.element();
		drag(stage, 'dragenter', true);
		await expect.element(page.getByText(`Drop to send to ${TEST_MACHINE.name}`)).toBeVisible();
		await expect.element(page.getByText("Saved to kim's Downloads/BMuster")).toBeVisible();
		expect(asked.some((url) => url.includes('/session-files/destination'))).toBe(true);
		document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
		await expect
			.element(page.getByText(`Drop to send to ${TEST_MACHINE.name}`))
			.not.toBeInTheDocument();
		drag(stage, 'dragover', true);
		await expect.element(page.getByText(`Drop to send to ${TEST_MACHINE.name}`)).toBeVisible();
		drag(stage, 'dragleave', true);
		await expect
			.element(page.getByText(`Drop to send to ${TEST_MACHINE.name}`))
			.not.toBeInTheDocument();
		const text = drag(stage, 'dragover', false);
		expect(text.defaultPrevented).toBe(true);
		await expect
			.element(page.getByText(`Drop to send to ${TEST_MACHINE.name}`))
			.not.toBeInTheDocument();
	});

	it('SF14: where sending is not allowed the overlay says why and a drop sends nothing', async () => {
		const { screen } = await open(CONTROL, 'Connect');
		stubFilesServer();
		const stage = screen
			.getByRole('application', { name: `Screen of ${TEST_MACHINE.name}` })
			.element();
		const over = drag(stage, 'dragover', true);
		expect(over.dataTransfer?.dropEffect).toBe('none');
		await expect
			.element(
				page.getByText("You don't have permission to send files to this machine.", { exact: false })
			)
			.toBeVisible();
		expect(drag(stage, 'drop', true).defaultPrevented).toBe(true);
		expect(asked).toEqual([]);
	});

	it('SF15: Upload files and Transfers are on the bar only when sending is allowed', async () => {
		const allowed = await open(FILES, 'Connect');
		await expect
			.element(allowed.screen.getByRole('button', { name: 'Upload files' }))
			.toBeVisible();
		await expect.element(allowed.screen.getByRole('button', { name: 'Transfers' })).toBeVisible();
		await allowed.screen.unmount();
		const refused = await open(CONTROL, 'Connect');
		await expect.element(refused.screen.getByRole('button', { name: 'Keys' })).toBeVisible();
		await expect
			.element(refused.screen.getByRole('button', { name: 'Upload files' }))
			.not.toBeInTheDocument();
	});
});

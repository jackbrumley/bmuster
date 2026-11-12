import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { userEvent } from 'vitest/browser';
import { z } from 'zod';
import '#lib/ui/design-tokens.css';
import { batch, CONTROL, open, stubDesktopServer } from './desktop-test-harness.ts';

// SPEC-DESKTOP 22 LC8, LC9: the local cursor on the desktop tab.

beforeEach(stubDesktopServer);

afterEach(() => {
	sessionStorage.clear();
});

/** A cursor message's 20-byte header (SPEC-DESKTOP 4.1) and its body. */
function cursorMessage(type: 3 | 4, body: number): { bytes: Uint8Array; view: DataView } {
	const bytes = new Uint8Array(20 + body);
	bytes.set([type, 0, 0, 1]);
	return { bytes, view: new DataView(bytes.buffer) };
}

/** An 8x8 opaque red cursor with its hotspot at (1, 1), as the agent sends a shape. */
async function cursorShape(id: number): Promise<Uint8Array> {
	const canvas = new OffscreenCanvas(8, 8);
	const context = canvas.getContext('2d');
	if (context === null) throw new Error('no 2d context');
	context.fillStyle = 'rgb(255, 0, 0)';
	context.fillRect(0, 0, 8, 8);
	const blob = await canvas.convertToBlob({ type: 'image/png' });
	const png = new Uint8Array(await blob.arrayBuffer());
	const { bytes, view } = cursorMessage(3, 8 + png.length);
	view.setUint32(20, id, true);
	view.setUint16(24, 1, true);
	view.setUint16(26, 1, true);
	bytes.set(png, 28);
	return bytes;
}

function cursorAt(id: number, x: number, y: number, visible: boolean): Uint8Array {
	const { bytes, view } = cursorMessage(4, 13);
	view.setUint32(20, id, true);
	view.setInt32(24, x, true);
	view.setInt32(28, y, true);
	bytes[32] = visible ? 1 : 0;
	return bytes;
}

/** The cursor canvas's alpha at a frame pixel: 255 where the remote cursor is drawn. */
function cursorAlpha(container: HTMLElement, x: number, y: number): number {
	const canvas = container.querySelector<HTMLCanvasElement>('canvas.cursor');
	return canvas?.getContext('2d')?.getImageData(x, y, 1, 1).data[3] ?? -1;
}

/** A 1920x960 picture of the 256x128 display, so an 8-pixel cursor fits a CSS cursor. */
const BIG_FRAME = { width: 1920, height: 960 };

const pointerMessage = z.object({ type: z.literal('pointer'), x: z.number(), y: z.number() });

describe('the local cursor', () => {
	it('LC8: a mouse wears the remote cursor as its CSS cursor, and the canvas draws none while they agree', async () => {
		const { screen, socket } = await open(CONTROL, 'Connect');
		socket.receive(batch(1, 1 | 4, [{ x: 0, y: 0, rgb: [1, 2, 3] }], BIG_FRAME));
		await expect.poll(() => socket.messages()).toContainEqual({ type: 'ack', seq: 1 });
		socket.receive(await cursorShape(7));
		socket.receive(cursorAt(7, 100, 50, true));
		// No input from us yet: the agent's cursor is drawn where it says.
		await expect.poll(() => cursorAlpha(screen.container, 101, 51)).toBe(255);

		const stage = screen.getByRole('application', { name: /Screen of/ });
		await userEvent.hover(stage, { position: { x: 60, y: 30 } });
		await expect.poll(() => stage.element().style.cursor).toMatch(/url\(/);
		const pointers = socket.messages().flatMap((message) => {
			const parsed = pointerMessage.safeParse(message);
			return parsed.success ? [parsed.data] : [];
		});
		const sent = pointers.at(-1);
		if (sent === undefined) throw new Error('no pointer sent');
		// The agent follows our pointer: one cursor, the viewer's own, even after input rests.
		const fx = Math.round(sent.x * 7.5);
		const fy = Math.round(sent.y * 7.5);
		socket.receive(cursorAt(7, fx, fy, true));
		await new Promise((done) => setTimeout(done, 700));
		expect(cursorAlpha(screen.container, fx + 1, fy + 1)).toBe(0);
		expect(cursorAlpha(screen.container, 101, 51)).toBe(0);

		// Someone at the machine moves it: the reported cursor shows again.
		socket.receive(cursorAt(7, 900, 400, true));
		await expect.poll(() => cursorAlpha(screen.container, 901, 401)).toBe(255);

		// Hidden at the machine (a game): hidden here too.
		socket.receive(cursorAt(7, 900, 400, false));
		await expect.poll(() => stage.element().style.cursor).toBe('none');
		expect(cursorAlpha(screen.container, 901, 401)).toBe(0);
	});

	it('LC9: view only keeps the viewer cursor and draws the agent cursor', async () => {
		const { screen, socket } = await open(CONTROL, 'Watch only');
		socket.receive(batch(1, 1 | 4, [{ x: 0, y: 0, rgb: [1, 2, 3] }], BIG_FRAME));
		await expect.poll(() => socket.messages()).toContainEqual({ type: 'ack', seq: 1 });
		socket.receive(await cursorShape(7));
		socket.receive(cursorAt(7, 100, 50, true));
		const stage = screen.getByRole('application', { name: /Screen of/ });
		await userEvent.hover(stage, { position: { x: 60, y: 30 } });
		await expect.poll(() => cursorAlpha(screen.container, 101, 51)).toBe(255);
		socket.receive(cursorAt(7, 100, 50, false));
		await expect.poll(() => cursorAlpha(screen.container, 101, 51)).toBe(0);
		expect(stage.element().style.cursor).toBe('');
	});
});

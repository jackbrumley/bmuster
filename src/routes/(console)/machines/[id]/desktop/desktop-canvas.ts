import type { FrameHeader, Tile } from '#lib/domain/desktop/frame.ts';

/**
 * Drawing the remote screen (SPEC-DESKTOP R1, R6): JPEG tiles decoded with
 * `createImageBitmap` and drawn where they belong, solid tiles filled. The
 * cursor is drawn on its own canvas above, from the shape the agent sent
 * once and the position it sends as the pointer moves, so pointer movement
 * costs no video.
 */

type Shape = { image: ImageBitmap; hotspotX: number; hotspotY: number };

function blobOf(bytes: Uint8Array, type: string): Blob {
	return new Blob([new Uint8Array(bytes)], { type });
}

async function decode(tile: Tile): Promise<ImageBitmap | undefined> {
	switch (tile.format) {
		case 'jpeg':
			return createImageBitmap(blobOf(tile.bytes, 'image/jpeg'));
		case 'webp':
			return createImageBitmap(blobOf(tile.bytes, 'image/webp'));
		case 'solid':
			return undefined;
	}
}

/** A solid tile's pixels: its one colour (the machine's, not the console's theme) repeated. */
function solid(tile: Tile): ImageData {
	const image = new ImageData(Math.max(1, tile.w), Math.max(1, tile.h));
	const [r = 0, g = 0, b = 0] = tile.bytes;
	for (let at = 0; at < image.data.length; at += 4) {
		image.data[at] = r;
		image.data[at + 1] = g;
		image.data[at + 2] = b;
		image.data[at + 3] = 255;
	}
	return image;
}

export class DesktopCanvas {
	readonly #screen: HTMLCanvasElement;
	readonly #cursor: HTMLCanvasElement;
	readonly #shapes = new Map<number, Shape>();
	#pointer: { id: number; x: number; y: number; visible: boolean } | undefined;

	constructor(screen: HTMLCanvasElement, cursor: HTMLCanvasElement) {
		this.#screen = screen;
		this.#cursor = cursor;
	}

	/** The picture's size in stream pixels; 0 before the first frame. */
	get size(): { width: number; height: number } {
		return { width: this.#screen.width, height: this.#screen.height };
	}

	/** Draws one whole frame (every batch of it). Decoding runs in parallel; drawing in order. */
	async draw(header: FrameHeader, tiles: readonly Tile[]): Promise<void> {
		const images = await Promise.all(tiles.map(decode));
		if (this.#screen.width !== header.width || this.#screen.height !== header.height) {
			this.#screen.width = header.width;
			this.#screen.height = header.height;
			this.#cursor.width = header.width;
			this.#cursor.height = header.height;
			this.#drawCursor();
		}
		const context = this.#screen.getContext('2d', { alpha: false });
		if (context === null) {
			return;
		}
		tiles.forEach((tile, index) => {
			const image = images[index];
			if (image !== undefined) {
				context.drawImage(image, tile.x, tile.y);
				image.close();
			} else {
				context.putImageData(solid(tile), tile.x, tile.y);
			}
		});
	}

	async cursorShape(
		id: number,
		hotspotX: number,
		hotspotY: number,
		png: Uint8Array
	): Promise<void> {
		const image = await createImageBitmap(blobOf(png, 'image/png'));
		this.#shapes.get(id)?.image.close();
		this.#shapes.set(id, { image, hotspotX, hotspotY });
		this.#drawCursor();
	}

	cursorPosition(id: number, x: number, y: number, visible: boolean): void {
		this.#pointer = { id, x, y, visible };
		this.#drawCursor();
	}

	/** A new page or display: shapes are sent again. */
	forgetCursor(): void {
		for (const shape of this.#shapes.values()) {
			shape.image.close();
		}
		this.#shapes.clear();
		this.#pointer = undefined;
		this.#drawCursor();
	}

	#drawCursor(): void {
		const context = this.#cursor.getContext('2d');
		if (context === null) {
			return;
		}
		context.clearRect(0, 0, this.#cursor.width, this.#cursor.height);
		const pointer = this.#pointer;
		const shape = pointer === undefined ? undefined : this.#shapes.get(pointer.id);
		if (pointer?.visible === true && shape !== undefined) {
			context.drawImage(shape.image, pointer.x - shape.hotspotX, pointer.y - shape.hotspotY);
		}
	}
}

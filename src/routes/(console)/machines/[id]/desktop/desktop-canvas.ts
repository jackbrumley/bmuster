import type { FrameHeader, Tile } from '#lib/domain/desktop/frame.ts';
import type { LocalCursor } from './local-cursor.ts';

/**
 * Drawing the remote screen (SPEC-DESKTOP R1, R6): JPEG tiles decoded with
 * `createImageBitmap` and drawn where they belong, solid tiles filled. The
 * cursor is the local cursor's (local-cursor.ts, SPEC-DESKTOP 22), so
 * pointer movement costs no video; its canvas follows the picture's size.
 */

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
	readonly #cursor: LocalCursor;

	constructor(screen: HTMLCanvasElement, cursor: LocalCursor) {
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
			this.#cursor.resize(header.width, header.height);
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
}

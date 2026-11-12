import {
	cursorCrop,
	cssCursorSize,
	cssCursorValues,
	cursorScale,
	displayToFrame,
	frameToDisplay,
	movedByItself,
	planCursor,
	SETTLE_MS,
	type Crop,
	type CssCursor,
	type CursorSize,
	type CursorState,
	type InputKind
} from './cursor-plan.ts';
import { contentBox, type Point } from './input.ts';
import type { Geometry } from './touch-gestures.ts';
import type { Zoom } from './zoom.ts';

/**
 * The remote cursor in the browser (SPEC-DESKTOP 4.2 and 22): the shapes
 * the agent sends once, where it says the cursor is, and where we last sent
 * the pointer. `cursor-plan.ts` decides what shows; this draws it: the
 * stage's CSS cursor for a mouse (drawn by the viewer's own computer, with
 * no lag), the cursor canvas otherwise. Nothing here touches the machine's
 * own cursor.
 */

type Shape = {
	image: ImageBitmap;
	hotspotX: number;
	hotspotY: number;
	/** CSS cursor values by shown size and pixel ratio. */
	css: Map<string, string[]>;
};

export type LocalCursorHost = {
	/** The unzoomed picture box, the picture's size and the display's. */
	geometry(): Geometry | undefined;
	zoom(): Zoom;
	/** False for a watch-only session or before the machine's end is open. */
	controlling(): boolean;
};

/** What the screen input tells the cursor, and asks of it. */
export type CursorFeed = {
	/** We sent the pointer to this display point. */
	sent(x: number, y: number, kind: InputKind): void;
	/**
	 * Where the trackpad should carry on from, in display pixels: the
	 * reported cursor when it moved without our input; otherwise undefined.
	 */
	adoptable(): Point | undefined;
};

/** A picture of `shape` at `size` CSS pixels and `ratio` device pixels per CSS pixel. */
function pictureUrl(shape: Shape, size: CursorSize, ratio: number): string {
	const canvas = document.createElement('canvas');
	canvas.width = Math.max(1, Math.round(size.width * ratio));
	canvas.height = Math.max(1, Math.round(size.height * ratio));
	canvas.getContext('2d')?.drawImage(shape.image, 0, 0, canvas.width, canvas.height);
	return canvas.toDataURL('image/png');
}

/** The image's padding trimmed (cursorCrop); the whole image where pixels cannot be read. */
function cropOf(image: ImageBitmap, hotspot: Point): Crop {
	const size = { width: image.width, height: image.height };
	const context = new OffscreenCanvas(size.width, size.height).getContext('2d');
	if (context === null) {
		return { x: 0, y: 0, ...size };
	}
	context.drawImage(image, 0, 0);
	return cursorCrop(context.getImageData(0, 0, size.width, size.height).data, size, hotspot);
}

export class LocalCursor implements CursorFeed {
	readonly #surface: HTMLElement;
	readonly #canvas: HTMLCanvasElement;
	readonly #host: LocalCursorHost;
	readonly #shapes = new Map<number, Shape>();
	#reported: { id: number; x: number; y: number; visible: boolean } | undefined;
	/** Where we last sent the pointer, in frame pixels. */
	#sent: Point | undefined;
	#sentAt = -Infinity;
	#kind: InputKind = 'mouse';
	#over = false;
	#settle: ReturnType<typeof setTimeout> | undefined;
	/** The CSS cursor last set, so an unchanged one is not set again. */
	#applied = '';
	readonly #detach: () => void;

	constructor(surface: HTMLElement, canvas: HTMLCanvasElement, host: LocalCursorHost) {
		this.#surface = surface;
		this.#canvas = canvas;
		this.#host = host;
		const over = (event: PointerEvent) => {
			const next = event.pointerType !== 'touch' && event.target === surface;
			if (next !== this.#over) {
				this.#over = next;
				this.#render();
			}
		};
		const out = (event: PointerEvent) => {
			if (event.target === surface && this.#over) {
				this.#over = false;
				this.#render();
			}
		};
		surface.addEventListener('pointerover', over);
		surface.addEventListener('pointermove', over);
		surface.addEventListener('pointerout', out);
		this.#detach = () => {
			surface.removeEventListener('pointerover', over);
			surface.removeEventListener('pointermove', over);
			surface.removeEventListener('pointerout', out);
		};
	}

	/** The page is going away: the viewer's own cursor comes back. */
	detach(): void {
		this.#detach();
		clearTimeout(this.#settle);
		this.#surface.style.cursor = '';
		this.#applied = '';
	}

	/** The picture's size changed: the cursor canvas follows it. */
	resize(width: number, height: number): void {
		this.#canvas.width = width;
		this.#canvas.height = height;
		this.#render();
	}

	async shape(id: number, hotspotX: number, hotspotY: number, png: Uint8Array): Promise<void> {
		const whole = await createImageBitmap(new Blob([new Uint8Array(png)], { type: 'image/png' }));
		const crop = cropOf(whole, { x: hotspotX, y: hotspotY });
		const image = await createImageBitmap(whole, crop.x, crop.y, crop.width, crop.height);
		whole.close();
		this.#shapes.get(id)?.image.close();
		this.#shapes.set(id, {
			image,
			hotspotX: hotspotX - crop.x,
			hotspotY: hotspotY - crop.y,
			css: new Map()
		});
		this.#render();
	}

	position(id: number, x: number, y: number, visible: boolean): void {
		this.#reported = { id, x, y, visible };
		this.#render();
	}

	/** A new page or display: shapes are sent again. */
	forget(): void {
		for (const shape of this.#shapes.values()) {
			shape.image.close();
		}
		this.#shapes.clear();
		this.#reported = undefined;
		this.#sent = undefined;
		this.#render();
	}

	sent(x: number, y: number, kind: InputKind): void {
		const geometry = this.#host.geometry();
		if (geometry === undefined) {
			return;
		}
		this.#sent = displayToFrame({ x, y }, geometry.display, geometry.picture);
		this.#sentAt = performance.now();
		this.#kind = kind;
		clearTimeout(this.#settle);
		// Once our input rests, the agent's position counts again.
		this.#settle = setTimeout(() => {
			this.#render();
		}, SETTLE_MS + 20);
		this.#render();
	}

	adoptable(): Point | undefined {
		const geometry = this.#host.geometry();
		const state = this.#state();
		const reported = this.#reported;
		if (geometry === undefined || reported?.visible !== true) {
			return undefined;
		}
		if (!movedByItself(state, reported)) {
			return undefined;
		}
		return frameToDisplay(reported, geometry.picture, geometry.display);
	}

	#state(): CursorState {
		const reported = this.#reported;
		const shape = reported === undefined ? undefined : this.#shapes.get(reported.id);
		return {
			controlling: this.#host.controlling(),
			kind: this.#kind,
			// A visible cursor whose shape is still decoding leaves the viewer's alone for that moment.
			reportsCursor: this.#shapes.size > 0 && (reported?.visible !== true || shape !== undefined),
			reported,
			sent: this.#sent,
			over: this.#over,
			sinceInput: performance.now() - this.#sentAt,
			fits: shape !== undefined && this.#cssSize(shape) !== undefined
		};
	}

	/** The shape's CSS cursor size at the picture's shown scale and zoom. */
	#cssSize(shape: Shape): CursorSize | undefined {
		const geometry = this.#host.geometry();
		if (geometry === undefined) {
			return undefined;
		}
		const content = contentBox(geometry.box, geometry.picture);
		const scale = cursorScale(content.width, geometry.picture.width, this.#host.zoom().scale);
		return cssCursorSize(shape.image, scale);
	}

	#render(): void {
		const plan = planCursor(this.#state());
		this.#applyCss(plan.css);
		const context = this.#canvas.getContext('2d');
		if (context === null) {
			return;
		}
		context.clearRect(0, 0, this.#canvas.width, this.#canvas.height);
		const shape = this.#reported === undefined ? undefined : this.#shapes.get(this.#reported.id);
		if (plan.canvas.kind === 'at' && shape !== undefined) {
			context.drawImage(
				shape.image,
				plan.canvas.x - shape.hotspotX,
				plan.canvas.y - shape.hotspotY
			);
		}
	}

	#applyCss(css: CssCursor): void {
		const values = this.#cssValues(css);
		const key = values.join('\n');
		if (key === this.#applied) {
			return;
		}
		this.#applied = key;
		const style = this.#surface.style;
		style.cursor = '';
		// The first value the browser accepts wins (it ignores ones it cannot parse).
		for (const value of values) {
			style.cursor = value;
			if (style.cursor !== '') {
				return;
			}
		}
	}

	#cssValues(css: CssCursor): string[] {
		switch (css) {
			case 'default':
				return [];
			case 'none':
				return ['none'];
			case 'image': {
				const shape =
					this.#reported === undefined ? undefined : this.#shapes.get(this.#reported.id);
				const size = shape === undefined ? undefined : this.#cssSize(shape);
				if (shape === undefined || size === undefined) {
					return ['none'];
				}
				const ratio = Math.max(1, window.devicePixelRatio);
				const key = `${size.width}x${size.height}@${ratio}`;
				const cached = shape.css.get(key);
				if (cached !== undefined) {
					return cached;
				}
				const hotspot = {
					x: (shape.hotspotX * size.width) / shape.image.width,
					y: (shape.hotspotY * size.height) / shape.image.height
				};
				const pictures = [{ url: pictureUrl(shape, size, 1), pixelRatio: 1 }];
				if (ratio > 1) {
					// Sharp on a high-density screen; the plain one for a browser without image-set.
					pictures.unshift({ url: pictureUrl(shape, size, ratio), pixelRatio: ratio });
				}
				const values = cssCursorValues(pictures, hotspot);
				shape.css.set(key, values);
				return values;
			}
		}
	}
}

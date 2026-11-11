/**
 * A Windows icon file (.ico) writer and reader for `npm run icons:generate`
 * (SPEC-BRAND-ICON). An icon file is a directory of square images; each is
 * a 32-bit DIB (header, bottom-up BGRA pixels, an empty mask) or, at 256px,
 * a PNG, which is how Windows' own icons are laid out. Pure, so the unit
 * tests check the writer and the committed file.
 */

/** One image: its edge in pixels and its bytes (PNG or DIB). */
export interface IcoImage {
	readonly size: number;
	readonly data: Buffer;
}

const DIRECTORY = 6;
const ENTRY = 16;
const BITMAP_HEADER = 40;

/** Bytes per row of the 1-bit mask: one bit a pixel, padded to four bytes. */
function maskRow(size: number): number {
	return Math.ceil(size / 32) * 4;
}

/** A 32-bit DIB of straight (not premultiplied) RGBA pixels, top-down, `size` square. */
export function dib(rgba: Buffer, size: number): Buffer {
	if (rgba.length !== size * size * 4)
		throw new Error(`${String(size)}px pixels are the wrong length`);
	const pixels = size * size * 4;
	const out = Buffer.alloc(BITMAP_HEADER + pixels + maskRow(size) * size);
	out.writeUInt32LE(BITMAP_HEADER, 0);
	out.writeInt32LE(size, 4);
	// The colour pixels and the mask, one above the other.
	out.writeInt32LE(size * 2, 8);
	out.writeUInt16LE(1, 12);
	out.writeUInt16LE(32, 14);
	out.writeUInt32LE(pixels, 20);
	for (let y = 0; y < size; y++) {
		const row = BITMAP_HEADER + (size - 1 - y) * size * 4;
		for (let x = 0; x < size; x++) {
			const from = (y * size + x) * 4;
			const to = row + x * 4;
			out[to] = rgba[from + 2] ?? 0;
			out[to + 1] = rgba[from + 1] ?? 0;
			out[to + 2] = rgba[from] ?? 0;
			out[to + 3] = rgba[from + 3] ?? 0;
		}
	}
	// The mask stays clear: 32-bit pixels carry their own alpha.
	return out;
}

/** A DIB's pixels back as top-down RGBA. */
export function dibRgba(data: Buffer): { size: number; rgba: Buffer } {
	if (data.readUInt32LE(0) !== BITMAP_HEADER || data.readUInt16LE(14) !== 32)
		throw new Error('not a 32-bit DIB');
	const size = data.readInt32LE(4);
	const rgba = Buffer.alloc(size * size * 4);
	for (let y = 0; y < size; y++) {
		const row = BITMAP_HEADER + (size - 1 - y) * size * 4;
		for (let x = 0; x < size; x++) {
			const from = row + x * 4;
			const to = (y * size + x) * 4;
			rgba[to] = data[from + 2] ?? 0;
			rgba[to + 1] = data[from + 1] ?? 0;
			rgba[to + 2] = data[from] ?? 0;
			rgba[to + 3] = data[from + 3] ?? 0;
		}
	}
	return { size, rgba };
}

/** The icon file holding `images`, in the order given. */
export function icoFile(images: readonly IcoImage[]): Buffer {
	const header = Buffer.alloc(DIRECTORY + ENTRY * images.length);
	header.writeUInt16LE(0, 0);
	header.writeUInt16LE(1, 2);
	header.writeUInt16LE(images.length, 4);
	let offset = header.length;
	images.forEach((image, index) => {
		if (image.size < 1 || image.size > 256)
			throw new Error(`${String(image.size)}px is no icon size`);
		const entry = DIRECTORY + ENTRY * index;
		// 256 is written as 0.
		header.writeUInt8(image.size % 256, entry);
		header.writeUInt8(image.size % 256, entry + 1);
		header.writeUInt16LE(1, entry + 4);
		header.writeUInt16LE(32, entry + 6);
		header.writeUInt32LE(image.data.length, entry + 8);
		header.writeUInt32LE(offset, entry + 12);
		offset += image.data.length;
	});
	return Buffer.concat([header, ...images.map((image) => image.data)]);
}

/** The images in an icon file. */
export function readIco(bytes: Buffer): IcoImage[] {
	if (bytes.readUInt16LE(0) !== 0 || bytes.readUInt16LE(2) !== 1)
		throw new Error('not an icon file');
	const count = bytes.readUInt16LE(4);
	return Array.from({ length: count }, (_, index) => {
		const entry = DIRECTORY + ENTRY * index;
		const size = bytes.readUInt8(entry) === 0 ? 256 : bytes.readUInt8(entry);
		const length = bytes.readUInt32LE(entry + 8);
		const offset = bytes.readUInt32LE(entry + 12);
		if (offset + length > bytes.length)
			throw new Error(`image ${String(index)} lies outside the file`);
		return { size, data: bytes.subarray(offset, offset + length) };
	});
}

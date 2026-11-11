import { describe, expect, it } from 'vitest';
import { dib, dibRgba, icoFile, readIco } from '../../scripts/icons/ico.ts';

/** `size` square of one RGBA colour, with the top-left pixel marked. */
function pixels(size: number): Buffer {
	const rgba = Buffer.alloc(size * size * 4);
	for (let i = 0; i < rgba.length; i += 4) rgba.set([0x13, 0x20, 0x0f, 0xff], i);
	rgba.set([0xa3, 0xe6, 0x35, 0x80], 0);
	return rgba;
}

describe('the icon file writer (SPEC-BRAND-ICON)', () => {
	it('W5: a DIB is a 32-bit bitmap twice as tall, bottom-up BGRA, with a clear mask', () => {
		const image = dib(pixels(2), 2);
		expect(image.length).toBe(40 + 2 * 2 * 4 + 4 * 2);
		expect(image.readUInt32LE(0)).toBe(40);
		expect(image.readInt32LE(4)).toBe(2);
		expect(image.readInt32LE(8)).toBe(4);
		expect(image.readUInt16LE(12)).toBe(1);
		expect(image.readUInt16LE(14)).toBe(32);
		// The marked top-left pixel is the first pixel of the last row.
		expect([...image.subarray(40 + 8, 40 + 12)]).toEqual([0x35, 0xe6, 0xa3, 0x80]);
		expect([...image.subarray(40, 44)]).toEqual([0x0f, 0x20, 0x13, 0xff]);
		expect([...image.subarray(56)]).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
		expect(dibRgba(image)).toEqual({ size: 2, rgba: pixels(2) });
		expect(() => dib(pixels(2), 3)).toThrow();
	});

	it('W5: an icon file lists each image with its size and offset, 256 written as 0', () => {
		const small = dib(pixels(16), 16);
		const png = Buffer.from('\x89PNG\r\n\x1a\nfake', 'latin1');
		const file = icoFile([
			{ size: 16, data: small },
			{ size: 256, data: png }
		]);
		expect([...file.subarray(0, 6)]).toEqual([0, 0, 1, 0, 2, 0]);
		expect([...file.subarray(6, 14)]).toEqual([16, 16, 0, 0, 1, 0, 32, 0]);
		expect(file.readUInt32LE(14)).toBe(small.length);
		expect(file.readUInt32LE(18)).toBe(6 + 2 * 16);
		expect([...file.subarray(22, 24)]).toEqual([0, 0]);
		expect(file.readUInt32LE(34)).toBe(6 + 2 * 16 + small.length);
		expect(readIco(file)).toEqual([
			{ size: 16, data: small },
			{ size: 256, data: png }
		]);
		expect(() => icoFile([{ size: 257, data: png }])).toThrow();
		expect(() => readIco(Buffer.from([0, 0, 2, 0, 0, 0]))).toThrow();
	});
});

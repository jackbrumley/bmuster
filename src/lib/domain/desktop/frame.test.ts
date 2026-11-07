import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { FORMAT_VERSION, HEADER_LENGTH, parseFrame, type DesktopFrame } from './frame.ts';

// SPEC-DESKTOP R4, 11.1: the golden frames the agent's frame code writes.
const DIR = 'tests/fixtures/desktop-frames';

const headerSchema = z.object({
	type: z.int(),
	display: z.int(),
	flags: z.int(),
	version: z.int(),
	seq: z.int(),
	pts: z.int(),
	width: z.int(),
	height: z.int()
});

const manifestSchema = z.object({
	headerLength: z.int(),
	frames: z.array(
		z.object({
			file: z.string(),
			header: headerSchema,
			payload: z.discriminatedUnion('kind', [
				z.object({
					kind: z.literal('tiles'),
					tiles: z.array(
						z.object({
							x: z.int(),
							y: z.int(),
							w: z.int(),
							h: z.int(),
							format: z.int(),
							length: z.int(),
							rgba: z.array(z.int()).nullable()
						})
					)
				}),
				z.object({
					kind: z.literal('cursor-shape'),
					id: z.int(),
					hotspotX: z.int(),
					hotspotY: z.int(),
					pngLength: z.int()
				}),
				z.object({
					kind: z.literal('cursor-position'),
					id: z.int(),
					x: z.int(),
					y: z.int(),
					visible: z.boolean()
				})
			])
		})
	)
});

const manifest = manifestSchema.parse(JSON.parse(readFileSync(join(DIR, 'manifest.json'), 'utf8')));

const FORMAT_CODES = { jpeg: 1, webp: 2, solid: 3 } as const;

function read(file: string): DesktopFrame {
	const parsed = parseFrame(new Uint8Array(readFileSync(join(DIR, file))));
	if (parsed.kind !== 'frame') throw new Error(parsed.message);
	return parsed.frame;
}

describe('desktop frames (R4)', () => {
	it('has a 20-byte header, as the agent writes it', () => {
		expect(manifest.headerLength).toBe(HEADER_LENGTH);
		expect(manifest.frames.length).toBeGreaterThanOrEqual(6);
	});

	for (const golden of manifest.frames) {
		it(`reads ${golden.file} as the agent wrote it`, () => {
			const frame = read(golden.file);
			expect(frame.header).toEqual(golden.header);
			const payload = golden.payload;
			switch (payload.kind) {
				case 'tiles':
					if (frame.kind !== 'tiles') throw new Error(frame.kind);
					expect(
						frame.tiles.map((tile) => ({
							x: tile.x,
							y: tile.y,
							w: tile.w,
							h: tile.h,
							format: FORMAT_CODES[tile.format],
							length: tile.bytes.byteLength,
							rgba: tile.format === 'solid' ? [...tile.bytes] : null
						}))
					).toEqual(payload.tiles);
					return;
				case 'cursor-shape':
					if (frame.kind !== 'cursor-shape') throw new Error(frame.kind);
					expect({
						id: frame.id,
						hotspotX: frame.hotspotX,
						hotspotY: frame.hotspotY,
						pngLength: frame.png.byteLength
					}).toEqual({
						id: payload.id,
						hotspotX: payload.hotspotX,
						hotspotY: payload.hotspotY,
						pngLength: payload.pngLength
					});
					return;
				case 'cursor-position':
					if (frame.kind !== 'cursor-position') throw new Error(frame.kind);
					expect({ id: frame.id, x: frame.x, y: frame.y, visible: frame.visible }).toEqual({
						id: payload.id,
						x: payload.x,
						y: payload.y,
						visible: payload.visible
					});
					return;
			}
		});
	}

	it('refuses another format version with a clear message, and cut-short frames', () => {
		const bytes = new Uint8Array(readFileSync(join(DIR, 'tile-keyframe.bin')));
		const other = bytes.slice();
		other[3] = FORMAT_VERSION + 1;
		expect(parseFrame(other)).toMatchObject({ kind: 'bad', wrongVersion: true });
		expect(parseFrame(bytes.slice(0, bytes.byteLength - 1))).toMatchObject({
			kind: 'bad',
			wrongVersion: false
		});
		expect(parseFrame(bytes.slice(0, 10))).toMatchObject({ kind: 'bad' });
	});
});

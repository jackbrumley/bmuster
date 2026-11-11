import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
	ICO_FILE,
	ICO_LARGEST_DIB,
	ICO_SIZES,
	PNG_ICONS,
	SOURCE,
	TRAY_SIZES,
	argb,
	errorPageLogo,
	svgFiles,
	trayFile
} from '../../scripts/icons/drawing.ts';
import { dibRgba, readIco } from '../../scripts/icons/ico.ts';

const sourceText = readFileSync(SOURCE, 'utf8');

/** A PNG's width and height, from its IHDR chunk; `file` is a path or the PNG itself. */
function pngSize(file: string | Buffer): [number, number] {
	const bytes = typeof file === 'string' ? readFileSync(file) : file;
	expect(bytes.subarray(1, 4).toString('latin1')).toBe('PNG');
	return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
}

describe('icons from one drawing (SPEC-BRAND-ICON)', () => {
	it('I1: every committed SVG icon is what icons:generate makes from docs/logo.svg', () => {
		for (const [file, svg] of svgFiles(sourceText)) {
			expect(readFileSync(file, 'utf8'), `${file}: run npm run icons:generate`).toBe(svg);
		}
	});

	it('I1: the drawing is the night radar: a dark disc with no tile, a lime beam, muted rings', () => {
		expect(sourceText).not.toContain('id="tile"');
		expect(sourceText).toMatch(/<circle id="face"[^>]*fill="#13200f"/);
		expect(sourceText).toMatch(/<path id="beam"[^>]*stroke="#a3e635"/);
		expect(sourceText).toMatch(/<circle id="ring-outer"[^>]*stroke="#7f9a72"/);
		for (const id of ['ring-inner', 'blip', 'blip-faint', 'blip-halo', 'centre', 'sweep']) {
			expect(sourceText).toContain(`id="${id}"`);
		}
	});

	it('I2: the last-resort error page carries the current logo inline', () => {
		expect(readFileSync('src/error.html', 'utf8')).toContain(`src="${errorPageLogo(sourceText)}"`);
	});

	it('I3: each app icon PNG has its size, and the manifest and layout name only real files', () => {
		for (const icon of PNG_ICONS) expect(pngSize(icon.file)).toEqual([icon.size, icon.size]);
		const manifest = z
			.object({ icons: z.array(z.object({ src: z.string(), sizes: z.string() })) })
			.parse(JSON.parse(readFileSync('static/manifest.webmanifest', 'utf8')));
		for (const icon of manifest.icons) {
			const file = `static/${icon.src}`;
			expect(existsSync(file), file).toBe(true);
			if (icon.sizes !== 'any') {
				const [width, height] = pngSize(file);
				expect(`${String(width)}x${String(height)}`).toBe(icon.sizes);
			}
		}
		const layout = readFileSync('src/routes/+layout.svelte', 'utf8');
		for (const [, name] of layout.matchAll(/asset\('([^']+)'\)/g)) {
			expect(existsSync(`static/${name ?? ''}`), name).toBe(true);
		}
	});

	it('I7: the Windows icon holds every size, drawn from the same drawing as the tray pixels', () => {
		const images = readIco(readFileSync(ICO_FILE));
		expect(images.map((image) => image.size)).toEqual([...ICO_SIZES]);
		for (const image of images) {
			if (image.size > ICO_LARGEST_DIB) {
				expect(pngSize(image.data)).toEqual([image.size, image.size]);
				continue;
			}
			const { size, rgba } = dibRgba(image.data);
			expect(size).toBe(image.size);
			const centre = (Math.floor(size / 2) * size + Math.floor(size / 2)) * 4;
			expect(rgba[centre + 3], `${String(size)}px centre alpha`).toBe(255);
			expect(rgba[3], `${String(size)}px corner alpha`).toBe(0);
			// The same rasterising as the tray's ARGB files at the shared sizes.
			if ((TRAY_SIZES as readonly number[]).includes(size)) {
				expect(argb(rgba).equals(readFileSync(trayFile(size))), `${String(size)}px`).toBe(true);
			}
		}
	});

	it('I5: each tray icon is raw ARGB of its size: an opaque disc with clear corners', () => {
		for (const size of TRAY_SIZES) {
			const pixels = readFileSync(trayFile(size));
			expect(pixels.length).toBe(size * size * 4);
			const centre = (Math.floor(size / 2) * size + Math.floor(size / 2)) * 4;
			expect(pixels[centre], `${String(size)}px centre alpha`).toBe(255);
			expect(pixels[0], `${String(size)}px corner alpha`).toBe(0);
		}
	});
});

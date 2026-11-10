import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
	PNG_ICONS,
	SOURCE,
	TRAY_SIZES,
	errorPageLogo,
	svgFiles,
	trayFile
} from '../../scripts/icons/drawing.ts';

const sourceText = readFileSync(SOURCE, 'utf8');

/** A PNG's width and height, from its IHDR chunk. */
function pngSize(file: string): [number, number] {
	const bytes = readFileSync(file);
	expect(bytes.subarray(1, 4).toString('latin1')).toBe('PNG');
	return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
}

describe('icons from one drawing (SPEC-BRAND-ICON)', () => {
	it('I1: every committed SVG icon is what icons:generate makes from docs/logo.svg', () => {
		for (const [file, svg] of svgFiles(sourceText)) {
			expect(readFileSync(file, 'utf8'), `${file}: run npm run icons:generate`).toBe(svg);
		}
	});

	it('I1: the drawing keeps the light-mode look: white tile, brand green, muted rings', () => {
		expect(sourceText).toMatch(/<rect id="tile"[^>]*fill="#ffffff"/);
		expect(sourceText).toMatch(/<path id="beam"[^>]*stroke="#46720e"/);
		expect(sourceText).toMatch(/<circle id="ring-outer"[^>]*stroke="#657061"/);
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

	it('I5: each tray icon is raw ARGB of its size', () => {
		for (const size of TRAY_SIZES) {
			expect(readFileSync(trayFile(size)).length).toBe(size * size * 4);
		}
	});
});

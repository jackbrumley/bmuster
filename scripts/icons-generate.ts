/**
 * Builds every BMuster icon from the one source drawing, docs/logo.svg
 * (`npm run icons:generate`, SPEC-BRAND-ICON). Run it after changing the
 * drawing and commit what it writes; nothing runs it at build time.
 *
 * It draws two versions: the full mark (two rings, the long sweep, both
 * blips) and a small one for 32px and below (one thicker ring, a short
 * sweep, one blip), made by dropping and thickening the elements the
 * drawing names by id. Pixels come from the Chromium that Playwright
 * already installs for the browser tests, so it needs no image library or
 * system tool.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { chromium, type Page } from 'playwright';
import {
	PNG_ICONS,
	SOURCE,
	TRAY_SIZES,
	argb,
	dataUri,
	errorPageLogo,
	fullBleed,
	small,
	svgFiles,
	trayFile,
	withoutComments
} from './icons/drawing.ts';

/** Draws the SVG at `size` and returns its PNG bytes and its straight (not premultiplied) RGBA pixels. */
async function rasterise(
	page: Page,
	svg: string,
	size: number
): Promise<{ png: Buffer; rgba: Buffer }> {
	const drawn = await page.evaluate(
		async ({ source, edge }) => {
			const image = new Image(edge, edge);
			image.src = source;
			await image.decode();
			const canvas = document.createElement('canvas');
			canvas.width = edge;
			canvas.height = edge;
			const context = canvas.getContext('2d');
			if (context === null) throw new Error('No 2D canvas');
			context.drawImage(image, 0, 0, edge, edge);
			return {
				png: canvas.toDataURL('image/png'),
				rgba: Array.from(context.getImageData(0, 0, edge, edge).data)
			};
		},
		{ source: dataUri(svg), edge: size }
	);
	return {
		png: Buffer.from(drawn.png.slice(drawn.png.indexOf(',') + 1), 'base64'),
		rgba: Buffer.from(drawn.rgba)
	};
}

/** The error page needs no request, so it carries the logo as a data URI. */
async function inlineInErrorPage(uri: string): Promise<void> {
	const file = 'src/error.html';
	const html = await readFile(file, 'utf8');
	const pattern = /src="data:image\/svg\+xml;base64,[^"]*"/g;
	if ((html.match(pattern) ?? []).length !== 1)
		throw new Error(`${file}: expected one logo data URI`);
	await write(file, html.replace(pattern, `src="${uri}"`));
}

async function write(file: string, content: string | Buffer): Promise<void> {
	await writeFile(file, content);
	console.log(file);
}

const sourceText = await readFile(SOURCE, 'utf8');
for (const [file, svg] of svgFiles(sourceText)) await write(file, svg);
await inlineInErrorPage(errorPageLogo(sourceText));

const full = withoutComments(sourceText);
const drawings = { full, 'full-bleed': fullBleed(full), small: small(full) } as const;
const browser = await chromium.launch();
try {
	const page = await browser.newPage();
	for (const icon of PNG_ICONS) {
		await write(icon.file, (await rasterise(page, drawings[icon.drawing], icon.size)).png);
	}
	for (const size of TRAY_SIZES) {
		const { rgba } = await rasterise(page, drawings.small, size);
		await write(trayFile(size), argb(rgba));
	}
} finally {
	await browser.close();
}

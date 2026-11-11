/**
 * Builds every BMuster icon from the one source drawing, docs/logo.svg
 * (`npm run icons:generate`, SPEC-BRAND-ICON). Run it after changing the
 * drawing and commit what it writes; nothing runs it at build time.
 *
 * Every file is the same drawing at every size (Jack, 2026-11-11: one
 * version scaled reads better than a separate small one); only the iPhone
 * icon gets an opaque square behind it. Pixels come from the Chromium that Playwright
 * already installs for the browser tests, so it needs no image library or
 * system tool.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { chromium, type Page } from 'playwright';
import {
	ICO_FILE,
	ICO_LARGEST_DIB,
	ICO_SIZES,
	PNG_ICONS,
	SOURCE,
	TRAY_SIZES,
	argb,
	dataUri,
	errorPageLogo,
	fullBleed,
	svgFiles,
	trayFile,
	withoutComments
} from './icons/drawing.ts';
import { type IcoImage, dib, icoFile } from './icons/ico.ts';

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
const drawings = { full, 'full-bleed': fullBleed(full) } as const;
const browser = await chromium.launch();
try {
	const page = await browser.newPage();
	for (const icon of PNG_ICONS) {
		await write(icon.file, (await rasterise(page, drawings[icon.drawing], icon.size)).png);
	}
	for (const size of TRAY_SIZES) {
		const { rgba } = await rasterise(page, drawings.full, size);
		await write(trayFile(size), argb(rgba));
	}
	const images: IcoImage[] = [];
	for (const size of ICO_SIZES) {
		const { png, rgba } = await rasterise(page, drawings.full, size);
		images.push({ size, data: size > ICO_LARGEST_DIB ? png : dib(rgba, size) });
	}
	await write(ICO_FILE, icoFile(images));
} finally {
	await browser.close();
}

/**
 * Renders the PNG app icons from the logo (`npm run brand:icons`): the
 * apple-touch-icon and the web manifest's 192px and 512px icons. Run it after
 * changing static/brand/bmuster-logo.svg and commit the PNGs. It uses the
 * Chromium that Playwright already installs for the browser tests, so it
 * needs no image library.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';

const LOGO = 'static/brand/bmuster-logo.svg';
/** iOS rounds the corners itself, so its icon fills the square (`fullBleed`). */
const ICONS = [
	{ file: 'static/apple-touch-icon.png', size: 180, fullBleed: true },
	{ file: 'static/brand/icon-192.png', size: 192, fullBleed: false },
	{ file: 'static/brand/icon-512.png', size: 512, fullBleed: false }
] as const;

const BODY = '<rect x="12" y="12" width="232" height="232" rx="44"';
const SQUARE = '<rect x="12" y="12" width="232" height="232" rx="0"';

const svg = await readFile(LOGO, 'utf8');
const browser = await chromium.launch();
try {
	for (const icon of ICONS) {
		const page = await browser.newPage({
			viewport: { width: icon.size, height: icon.size },
			deviceScaleFactor: 1
		});
		const sized = svg
			.replace('width="232" height="232"', `width="${icon.size}" height="${icon.size}"`)
			.replace(BODY, icon.fullBleed ? SQUARE : BODY);
		await page.setContent(
			`<!doctype html><html><body style="margin:0;background:transparent">${sized}</body></html>`
		);
		await writeFile(icon.file, await page.screenshot({ omitBackground: true }));
		await page.close();
		console.log(`${icon.file} (${icon.size}×${icon.size})`);
	}
} finally {
	await browser.close();
}

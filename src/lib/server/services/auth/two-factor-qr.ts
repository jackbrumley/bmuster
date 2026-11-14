import qrcode from 'qrcode-generator';
import type { QrPicture } from '#lib/domain/auth/two-factor.ts';

/** The blank border scanners need around a QR code, in modules. */
const QUIET_ZONE = 4;

/**
 * Draws a QR code on the server as one SVG path (SPEC-TWO-FACTOR 7), so set-up needs no
 * third-party service and no browser library. Each run of dark modules in a row is one
 * rectangle; the browser renders `<path d={path}>` in a `size`-square viewBox.
 */
export function qrPicture(text: string): QrPicture {
	const code = qrcode(0, 'M');
	code.addData(text, 'Byte');
	code.make();
	const count = code.getModuleCount();
	const parts: string[] = [];
	for (let row = 0; row < count; row += 1) {
		let column = 0;
		while (column < count) {
			if (!code.isDark(row, column)) {
				column += 1;
				continue;
			}
			const start = column;
			while (column < count && code.isDark(row, column)) {
				column += 1;
			}
			const width = column - start;
			parts.push(`M${start + QUIET_ZONE} ${row + QUIET_ZONE}h${width}v1h-${width}z`);
		}
	}
	return { size: count + QUIET_ZONE * 2, path: parts.join('') };
}

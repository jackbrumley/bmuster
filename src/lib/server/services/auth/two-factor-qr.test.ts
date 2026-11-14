import { describe, expect, it } from 'vitest';
import { qrPicture } from './two-factor-qr.ts';

const URI =
	'otpauth://totp/BMuster:ada%40example.com?secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP&issuer=BMuster&algorithm=SHA1&digits=6&period=30';

describe('QR code drawn on the server (SPEC-TWO-FACTOR TF2)', () => {
	it('is a whole QR code with its quiet zone, as one SVG path', () => {
		const picture = qrPicture(URI);
		// A version's side is 17 + 4 × version modules; the quiet zone adds 4 on each side.
		expect((picture.size - 8 - 17) % 4).toBe(0);
		expect(picture.size).toBeGreaterThan(8 + 21);
		// The top-left finder pattern: a 7-module dark row at the corner of the code.
		expect(picture.path.startsWith('M4 4h7v1h-7z')).toBe(true);
		expect(picture.path).toMatch(/^(M\d+ \d+h\d+v1h-\d+z)+$/);
	});

	it('holds the picture only, never the key as text', () => {
		const picture = qrPicture(URI);
		expect(picture.path).not.toContain('JBSWY3DP');
		expect(qrPicture(URI)).toEqual(picture);
	});
});

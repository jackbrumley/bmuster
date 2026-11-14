import { describe, expect, it } from 'vitest';
import { base32Encode } from './base32.ts';

describe('base32 (SPEC-TWO-FACTOR TF2)', () => {
	it('matches the RFC 4648 test vectors, without padding', () => {
		const vectors: [string, string][] = [
			['', ''],
			['f', 'MY'],
			['fo', 'MZXQ'],
			['foo', 'MZXW6'],
			['foob', 'MZXW6YQ'],
			['fooba', 'MZXW6YTB'],
			['foobar', 'MZXW6YTBOI']
		];
		for (const [text, encoded] of vectors) {
			expect(base32Encode(Buffer.from(text, 'ascii')), text).toBe(encoded);
		}
	});

	it('turns a 160-bit key into 32 characters', () => {
		expect(base32Encode(Buffer.alloc(20, 0xff))).toBe('7'.repeat(32));
	});
});

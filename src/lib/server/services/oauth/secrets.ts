import { createHash, randomBytes } from 'node:crypto';

/**
 * The opaque secrets BMuster's authorisation server hands out (SPEC-MCP M8, M33): codes
 * (`bmac_`), access and refresh tokens (`bmat_`, `bmrt_`) and client secrets (`bmcs_`), each 32
 * random bytes, and kept only as SHA-256. That is enough for values with this much entropy.
 */

export function hashSecret(secret: string): string {
	return createHash('sha256').update(secret, 'utf8').digest('hex');
}

export function newSecret(prefix: 'bmac_' | 'bmat_' | 'bmrt_' | 'bmcs_'): string {
	return `${prefix}${randomBytes(32).toString('base64url')}`;
}

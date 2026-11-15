import { z } from 'zod';

/**
 * The console runs under a strict Content-Security-Policy with no `unsafe-eval`
 * (SPEC-SIGN-IN S20). zod would otherwise probe `new Function` once to speed up
 * object parsing; the probe is caught, but Firefox reports it as a policy
 * violation on every page. Parsing without that speed-up is fast enough.
 */
z.config({ jitless: true });

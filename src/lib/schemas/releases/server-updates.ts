import { z } from 'zod';

export const stableVersionSchema = z.string().regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);
export const serverManifestSchema = z.strictObject({
	schemaVersion: z.literal(1),
	version: stableVersionSchema,
	target: z.enum([
		'x86_64-unknown-linux-gnu',
		'aarch64-unknown-linux-gnu',
		'x86_64-pc-windows-msvc'
	]),
	archive: z.string().max(120),
	bytes: z
		.int()
		.min(1)
		.max(1024 ** 3),
	sha256: z.string().regex(/^[a-f0-9]{64}$/),
	minimumLauncher: stableVersionSchema,
	nodeMajor: z.literal(26),
	rollbackFrom: z.array(stableVersionSchema).max(32)
});
export type ServerManifest = z.infer<typeof serverManifestSchema>;
const updateReleaseSchema = z.strictObject({
	version: stableVersionSchema,
	notes: z.string().max(20_000),
	publishedAtIso: z.iso.datetime(),
	manifest: serverManifestSchema
});
export const serverUpdateStateSchema = z.strictObject({
	current: stableVersionSchema.nullable(),
	previous: stableVersionSchema.nullable(),
	pending: stableVersionSchema.nullable(),
	phase: z.enum([
		'idle',
		'downloading',
		'preparing',
		'starting',
		'updated',
		'failed',
		'rolled-back'
	]),
	message: z.string().max(4000)
});
export const updateCacheSchema = z.strictObject({
	checkedAtIso: z.iso.datetime().nullable(),
	lastSuccessAtIso: z.iso.datetime().nullable(),
	release: updateReleaseSchema.nullable(),
	problem: z.string().nullable()
});
export const serverUpdateViewSchema = z.strictObject({
	installedVersion: stableVersionSchema,
	deployment: z.enum(['source', 'docker', 'installed']),
	launcherVersion: stableVersionSchema.nullable(),
	checkedAtIso: z.iso.datetime().nullable(),
	lastSuccessAtIso: z.iso.datetime().nullable(),
	release: updateReleaseSchema.nullable(),
	problem: z.string().nullable(),
	install: z.strictObject({ allowed: z.boolean(), reason: z.string() }),
	operation: serverUpdateStateSchema
});
export type ServerUpdateView = z.infer<typeof serverUpdateViewSchema>;
export type UpdateCache = z.infer<typeof updateCacheSchema>;

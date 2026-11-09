import { z } from 'zod';

export const stableVersionSchema = z.string().regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);
/**
 * The signed release manifest (bmuster-app-<target>.json). Field names are the release contract
 * installed servers already read; `minimumLauncher` is the oldest installed version that can
 * update to this release by itself (SPEC-SERVER-UPDATES).
 */
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
	nodeMajor: z.int().positive(),
	rollbackFrom: z.array(stableVersionSchema).max(32)
});
export type ServerManifest = z.infer<typeof serverManifestSchema>;
const updateReleaseSchema = z.strictObject({
	version: stableVersionSchema,
	notes: z.string().max(20_000),
	publishedAtIso: z.iso.datetime(),
	manifest: serverManifestSchema
});
/** update-status.json, written only by the root updater. */
export const updaterStatusSchema = z.strictObject({
	phase: z.enum([
		'checking',
		'up-to-date',
		'downloading',
		'switching',
		'starting',
		'healthy',
		'rolled-back',
		'failed'
	]),
	from: stableVersionSchema.nullable(),
	to: stableVersionSchema.nullable(),
	message: z.string().max(4000),
	atMs: z.int().nonnegative()
});
/** What the console shows: the updater's status, or the app's own request waiting for it. */
const serverUpdateOperationSchema = z.strictObject({
	phase: z.enum(['idle', 'requested', ...updaterStatusSchema.shape.phase.options]),
	from: stableVersionSchema.nullable(),
	to: stableVersionSchema.nullable(),
	message: z.string().max(4000),
	atIso: z.iso.datetime().nullable()
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
	checkedAtIso: z.iso.datetime().nullable(),
	lastSuccessAtIso: z.iso.datetime().nullable(),
	release: updateReleaseSchema.nullable(),
	problem: z.string().nullable(),
	install: z.strictObject({ allowed: z.boolean(), reason: z.string() }),
	operation: serverUpdateOperationSchema
});
export type ServerUpdateView = z.infer<typeof serverUpdateViewSchema>;
/** Update now's reply: when the request was written, so the page ignores older updater results. */
export const serverUpdateRequestedSchema = z.strictObject({
	requestedAtIso: z.iso.datetime(),
	view: serverUpdateViewSchema
});
export type ServerUpdateOperation = z.infer<typeof serverUpdateOperationSchema>;
export type UpdateCache = z.infer<typeof updateCacheSchema>;

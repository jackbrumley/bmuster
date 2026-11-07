import { updateSettingRequestSchema } from '#lib/schemas/settings/settings.ts';
import { database } from '#lib/server/database/app-database.ts';
import { env } from '#lib/server/env.ts';
import { route } from '#lib/server/guards/route.ts';
import {
	lanCertificateNames,
	localNetworkModeChanged
} from '#lib/server/services/agents/local-tls.ts';
import { listSettings, updateSetting } from '#lib/server/services/settings/settings.ts';
import { servedCertificate } from '#lib/server/tls/served-certificate.ts';
import { invalidRequest, readJson } from '../replies.server.ts';
import type { RequestHandler } from './$types';

/** GET /api/settings: every server setting with its current value (admins). */
export const GET: RequestHandler = route.admin(() =>
	Response.json({ settings: listSettings(database) })
);

/**
 * PATCH /api/settings: change one setting; audited (SPEC-SIGN-IN S16). Local
 * network mode also makes its certificate and tells agents (SPEC-INSTALL-OPTIONS L7).
 */
export const PATCH: RequestHandler = route.admin(async ({ request }, { user }) => {
	const parsed = updateSettingRequestSchema.safeParse(await readJson(request));
	if (!parsed.success) {
		return invalidRequest(parsed.error);
	}
	const now = Date.now();
	const result = updateSetting(database, user.id, parsed.data.key, parsed.data.value, now);
	switch (result.kind) {
		case 'changed':
			if (parsed.data.key === 'localNetworkMode') {
				localNetworkModeChanged(
					database,
					env.secretsKey,
					servedCertificate(),
					lanCertificateNames(),
					now
				);
			}
			return Response.json({ settings: result.settings });
		case 'invalid':
			return Response.json({ message: result.message }, { status: 400 });
	}
});

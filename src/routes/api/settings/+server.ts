import { updateSettingRequestSchema } from '#lib/schemas/settings/settings.ts';
import { database } from '#lib/server/database/app-database.ts';
import { route } from '#lib/server/guards/route.ts';
import { listSettings, updateSetting } from '#lib/server/services/settings/settings.ts';
import { invalidRequest, readJson } from '../replies.server.ts';
import type { RequestHandler } from './$types';

/** GET /api/settings: every server setting with its current value (admins). */
export const GET: RequestHandler = route.admin(() =>
	Response.json({ settings: listSettings(database) })
);

/** PATCH /api/settings: change one setting; audited (SPEC-SIGN-IN S16). */
export const PATCH: RequestHandler = route.admin(async ({ request }, { user }) => {
	const parsed = updateSettingRequestSchema.safeParse(await readJson(request));
	if (!parsed.success) {
		return invalidRequest(parsed.error);
	}
	const result = updateSetting(database, user.id, parsed.data.key, parsed.data.value, Date.now());
	switch (result.kind) {
		case 'changed':
			return Response.json({ settings: result.settings });
		case 'invalid':
			return Response.json({ message: result.message }, { status: 400 });
	}
});

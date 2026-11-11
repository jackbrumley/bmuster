import {
	joinInstallRequestSchema,
	type JoinInstallReply
} from '#lib/schemas/machines/support-codes.ts';
import { hasBuildFor, oneLineInstallCommand } from '#lib/domain/machines/agent-release.ts';
import { installPin } from '#lib/domain/settings/local-tls.ts';
import { database } from '#lib/server/database/app-database.ts';
import { env } from '#lib/server/env.ts';
import { route } from '#lib/server/guards/route.ts';
import { supportJoinCode } from '#lib/server/services/agents/support-codes.ts';
import { invalidRequest, readJson } from '../../api/replies.server.ts';
import { installOptions } from '../../(console)/add/install-options.server.ts';
import { joinRefusal } from '../join-replies.server.ts';
import type { RequestHandler } from './$types';

/**
 * POST /join/install: public. Three safe answers and an open enrolment code →
 * the one-line install command for each OS the server has a build for, with
 * the join code behind the enrolment code and, in local network mode, the
 * certificate pin (SPEC-JOIN J7, J9).
 */
export const POST: RequestHandler = route.public(async (event) => {
	const parsed = joinInstallRequestSchema.safeParse(await readJson(event.request));
	if (!parsed.success) {
		return parsed.error.issues.some((issue) => issue.path[0] === 'answers')
			? Response.json({ message: 'Answer the three questions first.' }, { status: 403 })
			: invalidRequest(parsed.error);
	}
	const now = Date.now();
	const result = supportJoinCode(
		database,
		env.secretsKey,
		{ typed: parsed.data.code, address: event.getClientAddress() },
		now
	);
	if (result.kind !== 'open') {
		return joinRefusal(result, now);
	}
	const { downloads, localTls } = installOptions(event.url.origin);
	const pin = installPin(localTls);
	const commandFor = (os: 'linux' | 'windows'): JoinInstallReply['linux'] =>
		hasBuildFor(os, downloads)
			? {
					kind: 'ready',
					command: oneLineInstallCommand(os, event.url.origin, result.joinCode, pin)
				}
			: { kind: 'none' };
	const reply: JoinInstallReply = { linux: commandFor('linux'), windows: commandFor('windows') };
	return Response.json(reply);
});

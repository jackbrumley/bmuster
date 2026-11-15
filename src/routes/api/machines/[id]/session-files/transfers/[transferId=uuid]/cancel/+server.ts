import { route } from '#lib/server/guards/route.ts';
import { cancelSend } from '#lib/server/services/sessions/session-files.ts';
import { sessionFilesContext, sessionFilesReply } from '../../../session-files.server.ts';
import type { RequestHandler } from './$types';

/** POST /api/machines/<id>/session-files/transfers/<transferId>/cancel: Cancel in the Transfers panel. */
export const POST: RequestHandler = route.user(async (event, { user }) =>
	sessionFilesReply(await cancelSend(sessionFilesContext(event, user), event.params.transferId))
);

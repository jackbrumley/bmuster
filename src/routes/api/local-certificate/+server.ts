import { database } from '#lib/server/database/app-database.ts';
import { env } from '#lib/server/env.ts';
import { route } from '#lib/server/guards/route.ts';
import {
	lanCertificateNames,
	renewLocalCertificate
} from '#lib/server/services/agents/local-tls.ts';
import { servedCertificate } from '#lib/server/tls/served-certificate.ts';
import type { RequestHandler } from './$types';

/**
 * POST /api/local-certificate: make a new local network certificate, served
 * from the next restart; connected agents learn its pin now. Audited
 * (SPEC-INSTALL-OPTIONS L7).
 */
export const POST: RequestHandler = route.admin((_event, { user }) => {
	renewLocalCertificate(
		database,
		env.secretsKey,
		servedCertificate(),
		lanCertificateNames(),
		user.id,
		Date.now()
	);
	return Response.json({ renewed: true });
});

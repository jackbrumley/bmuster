import type { z } from 'zod';

/** The request body as JSON, or undefined when it is not JSON (the schema then refuses it). */
export async function readJson(request: Request): Promise<unknown> {
	return request.json().catch(() => undefined);
}

/** 400 with the first problem the schema found, in words a person can act on. */
export function invalidRequest(error: z.ZodError): Response {
	const issue = error.issues[0];
	const message = issue === undefined ? 'The request is not valid.' : issue.message;
	return Response.json({ message }, { status: 400 });
}

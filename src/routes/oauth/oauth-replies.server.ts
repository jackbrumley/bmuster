/**
 * OAuth replies (RFC 6749 5.1, 5.2): JSON that is never cached, and errors as
 * `{ error, error_description }`.
 */
const NO_STORE = { 'cache-control': 'no-store', pragma: 'no-cache' } as const;

export function oauthJson(body: unknown, status: number): Response {
	return Response.json(body, { status, headers: NO_STORE });
}

export function oauthError(error: string, description: string, status: 400 | 401 | 429): Response {
	return oauthJson({ error, error_description: description }, status);
}

/** A form-encoded body as plain fields; repeated names keep the first. */
export async function readForm(request: Request): Promise<Record<string, string> | undefined> {
	const type = request.headers.get('content-type') ?? '';
	if (!type.toLowerCase().startsWith('application/x-www-form-urlencoded')) {
		return undefined;
	}
	const fields: Record<string, string> = {};
	for (const [name, value] of new URLSearchParams(await request.text())) {
		if (!(name in fields)) fields[name] = value;
	}
	return fields;
}

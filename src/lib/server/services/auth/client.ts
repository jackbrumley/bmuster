/** Who is asking: recorded on sessions and used for the per-address sign-in limit. */
export type SignInClient = { ip: string; userAgent: string };

/** The client of a SvelteKit request (structural, so this module needs no SvelteKit import). */
export function signInClient(event: {
	getClientAddress(): string;
	request: Request;
}): SignInClient {
	return {
		ip: event.getClientAddress(),
		userAgent: event.request.headers.get('user-agent') ?? ''
	};
}

// See https://svelte.dev/docs/kit/types#app.d.ts
import type { ConsoleUser } from '#lib/domain/users/user.ts';

declare global {
	/** The package.json version, put in at build time by vite.config.ts. */
	const __BMUSTER_VERSION__: string;

	namespace App {
		/**
		 * `reference` names the server log line of an unexpected error
		 * (SPEC-ERROR-PAGES E5). It is optional because SvelteKit's `error(status,
		 * message)` only takes a bare message while every other field is.
		 */
		interface Error {
			status: number;
			message: string;
			reference?: string;
		}
		interface Locals {
			/** Set by the session hook; the guards read it (SPEC-SIGN-IN S7). */
			session: { kind: 'none' } | { kind: 'signed-in'; user: ConsoleUser };
		}
		/** Set by the root layout for every page; the error page reads it (SPEC-ERROR-PAGES E1). */
		interface PageData {
			signedIn: boolean;
		}
		// interface PageState {}
		// interface Platform {}
	}
}

export {};

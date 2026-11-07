// See https://svelte.dev/docs/kit/types#app.d.ts
import type { ConsoleUser } from '#lib/domain/users/user.ts';

declare global {
	/** The package.json version, put in at build time by vite.config.ts. */
	const __BMUSTER_VERSION__: string;

	namespace App {
		// interface Error {}
		interface Locals {
			/** Set by the session hook; the guards read it (SPEC-SIGN-IN S7). */
			session: { kind: 'none' } | { kind: 'signed-in'; user: ConsoleUser };
		}
		// interface PageData {}
		// interface PageState {}
		// interface Platform {}
	}
}

export {};

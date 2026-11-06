// See https://svelte.dev/docs/kit/types#app.d.ts
declare global {
	/** The package.json version, put in at build time by vite.config.ts. */
	const __BMUSTER_VERSION__: string;

	namespace App {
		// interface Error {}
		// interface Locals {}
		// interface PageData {}
		// interface PageState {}
		// interface Platform {}
	}
}

export {};

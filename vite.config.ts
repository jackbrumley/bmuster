import { readFileSync } from 'node:fs';
import { defineConfig } from 'vitest/config';
import { playwright } from '@vitest/browser-playwright';
import basicSsl from '@vitejs/plugin-basic-ssl';
import adapter from '@sveltejs/adapter-node';
import { sveltekit } from '@sveltejs/kit/vite';

const packageJson: unknown = JSON.parse(readFileSync('package.json', 'utf8'));
if (
	typeof packageJson !== 'object' ||
	packageJson === null ||
	!('version' in packageJson) ||
	typeof packageJson.version !== 'string'
) {
	throw new Error('package.json has no version');
}
const version = packageJson.version;

export default defineConfig(({ command, mode }) => ({
	define: {
		// Shown at the bottom of the sidebar.
		__BMUSTER_VERSION__: JSON.stringify(version)
	},
	plugins: [
		sveltekit({
			compilerOptions: {
				// Runes everywhere in our code; libraries keep their own mode.
				runes: ({ filename }) =>
					filename.split(/[/\\]/).includes('node_modules') ? undefined : true
			},
			adapter: adapter()
		}),
		// `npm run dev` serves HTTPS with a self-signed certificate, so phones on
		// the local network get a secure context (clipboard, WebCodecs). Only for
		// `vite dev`: builds, previews and Vitest stay on plain HTTP.
		...(command === 'serve' && mode !== 'test' ? [basicSsl()] : [])
	],
	server: {
		// Exposes the dev server on the local network for phone testing:
		// https://<this machine's LAN address>:5173
		host: true
	},
	test: {
		expect: { requireAssertions: true },
		// Every test starts clean: spies restored, stubbed env and globals put back.
		restoreMocks: true,
		unstubEnvs: true,
		unstubGlobals: true,
		projects: [
			{
				extends: './vite.config.ts',
				test: {
					name: 'ui',
					browser: {
						enabled: true,
						provider: playwright(),
						instances: [{ browser: 'chromium', headless: true }]
					},
					include: ['src/**/*.svelte.test.ts'],
					exclude: ['src/lib/server/**']
				}
			},
			{
				extends: './vite.config.ts',
				test: {
					name: 'unit',
					environment: 'node',
					include: ['src/**/*.test.ts'],
					exclude: ['src/**/*.svelte.test.ts']
				}
			}
		]
	}
}));

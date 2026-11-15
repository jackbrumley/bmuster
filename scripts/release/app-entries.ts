/**
 * The Node entry points in a release bundle's app/ folder (SPEC-SERVER-INSTALL section 5), each
 * one ES module with node_modules left external. The bmuster-server launcher runs them by name:
 * server.js as the service (launcher.rs), account-recovery.js for `reset-password` and
 * `reset-two-factor` (recovery.rs). The container image runs the same files.
 */
import { build } from 'vite';

export const APP_ENTRIES = {
	server: 'server.ts',
	'account-recovery': 'scripts/account-recovery.ts'
} as const;

/** Bundles every entry into `outDir` as `<name>.js`; code they share goes to chunks/. */
export async function bundleAppEntries(outDir: string): Promise<void> {
	await build({
		configFile: false,
		logLevel: 'warn',
		build: {
			ssr: true,
			outDir,
			emptyOutDir: false,
			target: 'node26',
			minify: false,
			rolldownOptions: {
				input: APP_ENTRIES,
				output: { entryFileNames: '[name].js', chunkFileNames: 'chunks/[name]-[hash].js' }
			}
		}
	});
}

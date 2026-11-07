/**
 * npm run docker:local [-- --tag <name>]
 *
 * Builds the server image (docker/app/Dockerfile) for this computer from the
 * archive `npm run release:server-local` made, the same way the release
 * workflow builds it from the published archives (SPEC-HOSTING H1). Run
 * `npm run release:server-local` first.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

function fail(message: string): never {
	console.error(`docker:local: ${message}`);
	process.exit(1);
}

function run(command: string, args: readonly string[]): void {
	const result = spawnSync(command, args, { stdio: 'inherit' });
	if (result.status !== 0) {
		fail(`${command} ${args.join(' ')} failed (exit ${String(result.status)})`);
	}
}

/** Docker's architecture names, and the archive each one is built from. */
const ARCHIVES: Record<string, { docker: string; archive: string }> = {
	x64: { docker: 'amd64', archive: 'bmuster-server-linux-x64.tar.gz' },
	arm64: { docker: 'arm64', archive: 'bmuster-server-linux-arm64.tar.gz' }
};

const { values: options } = parseArgs({
	options: { tag: { type: 'string', default: 'bmuster:local' } }
});

const spec = ARCHIVES[process.arch];
if (process.platform !== 'linux' || spec === undefined) {
	fail(`the image is built from a Linux archive; this is ${process.platform}-${process.arch}`);
}
const archive = resolve('dist', 'release', spec.archive);
if (!existsSync(archive)) {
	fail(`${archive} is missing; run npm run release:server-local first`);
}

const context = resolve('dist', 'docker');
const unpacked = join(context, spec.docker);
rmSync(context, { recursive: true, force: true });
mkdirSync(unpacked, { recursive: true });
run('tar', ['-xzf', archive, '-C', unpacked]);

const version = readFileSync(join(unpacked, 'bmuster-server', 'VERSION'), 'utf8').trim();
const nodeVersion = readFileSync('.node-version', 'utf8').trim();
run('docker', [
	'build',
	'--file',
	join('docker', 'app', 'Dockerfile'),
	'--build-arg',
	`NODE_VERSION=${nodeVersion}`,
	'--build-arg',
	`BMUSTER_VERSION=${version}`,
	'--tag',
	options.tag,
	context
]);
console.log(`docker:local: built ${options.tag} (BMuster ${version}, linux/${spec.docker})`);

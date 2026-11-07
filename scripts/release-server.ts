/**
 * npm run release:server-local [-- --binaries <dir>]
 *
 * Builds the server release archive for this computer (SPEC-SERVER-INSTALL
 * I1, section 5) in dist/release/: the SvelteKit build, server.ts bundled,
 * production node_modules, the migrations, the Node runtime pinned in
 * .node-version (checked against nodejs.org's SHASUMS256.txt), the agent
 * builds and the bmuster-server launcher.
 *
 * Without --binaries the agent and launcher are built here with cargo, for
 * this computer only. The release workflow passes --binaries <dir>, a folder
 * of <target>/bmuster-agent[.exe] and <target>/bmuster-server[.exe] for
 * every agent target, built beforehand on each platform.
 *
 * It always packages for the computer it runs on, because node_modules
 * holds native modules for that platform.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
	chmodSync,
	copyFileSync,
	cpSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync
} from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { build } from 'vite';
import { z } from 'zod';
import { AGENT_TARGETS, type AgentTarget } from '../src/lib/domain/machines/agent-release.ts';
import { AGENT_MANIFEST, agentVersion, binaryName, hostTarget } from './agent-build.ts';

function fail(message: string): never {
	console.error(`release:server: ${message}`);
	process.exit(1);
}

function run(
	command: string,
	args: readonly string[],
	options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}
): void {
	// npm is a .cmd script on Windows, which only a shell can start.
	const shell = process.platform === 'win32' && command === 'npm';
	const result = spawnSync(command, args, { stdio: 'inherit', shell, ...options });
	if (result.status !== 0) {
		fail(`${command} ${args.join(' ')} failed (exit ${String(result.status)})`);
	}
}

/** Release platform names, the Rust target of each, and Node's own names. */
const PLATFORMS = {
	'linux-x64': { target: 'x86_64-unknown-linux-gnu', node: 'linux-x64', archive: 'tar.gz' },
	'linux-arm64': { target: 'aarch64-unknown-linux-gnu', node: 'linux-arm64', archive: 'tar.gz' },
	'windows-x64': { target: 'x86_64-pc-windows-msvc', node: 'win-x64', archive: 'zip' }
} as const satisfies Record<string, { target: AgentTarget; node: string; archive: string }>;
type Platform = keyof typeof PLATFORMS;

function platformOf(target: AgentTarget): Platform {
	switch (target) {
		case 'x86_64-unknown-linux-gnu':
			return 'linux-x64';
		case 'aarch64-unknown-linux-gnu':
			return 'linux-arm64';
		case 'x86_64-pc-windows-msvc':
			return 'windows-x64';
	}
}

const { values: options } = parseArgs({ options: { binaries: { type: 'string' } } });

const PackageJson = z.object({ version: z.string() });
const serverVersion = PackageJson.parse(JSON.parse(readFileSync('package.json', 'utf8'))).version;
const nodeVersion = readFileSync('.node-version', 'utf8').trim();
const target =
	hostTarget() ?? fail(`no release for this computer (${process.platform}-${process.arch})`);
const platform = platformOf(target);
const spec = PLATFORMS[platform];

const DIST = resolve('dist');
const STAGE = join(DIST, 'stage', platform);
const BUNDLE = join(STAGE, 'bmuster-server');
const APP = join(BUNDLE, 'app');
const CACHE = join(DIST, 'cache');
const OUT = join(DIST, 'release');
/** Windows' own bsdtar reads and writes zip files; a Git Bash tar on PATH cannot. */
const TAR = process.platform === 'win32' ? 'C:\\Windows\\System32\\tar.exe' : 'tar';

// ---------------------------------------------------------------------------
// The server
// ---------------------------------------------------------------------------

/**
 * `vite build` analyses the server routes, which opens the database: a
 * throwaway in-memory one, never the developer's file.
 */
function buildServer(): void {
	run(process.execPath, [join('node_modules', 'vite', 'bin', 'vite.js'), 'build'], {
		env: {
			...process.env,
			DATABASE_PATH: ':memory:',
			SECRETS_KEY: Buffer.alloc(32).toString('base64'),
			RELEASES_PATH: join(STAGE, 'no-releases')
		}
	});
}

/** server.ts as one ES module beside build/; node_modules stay external. */
async function bundleServerEntry(): Promise<void> {
	await build({
		configFile: false,
		logLevel: 'warn',
		build: {
			ssr: 'server.ts',
			outDir: APP,
			emptyOutDir: false,
			target: 'node26',
			minify: false,
			rolldownOptions: { output: { entryFileNames: 'server.js' } }
		}
	});
}

/** Production dependencies for this platform, without build-only files. */
function installDependencies(): void {
	copyFileSync('package.json', join(APP, 'package.json'));
	copyFileSync('package-lock.json', join(APP, 'package-lock.json'));
	// better-sqlite3 ships prebuilt binaries, so no install script needs to run.
	run('npm', ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: APP });
	rmSync(join(APP, 'node_modules', '.bin'), { recursive: true, force: true });
	const sqlite = join(APP, 'node_modules', 'better-sqlite3');
	rmSync(join(sqlite, 'deps'), { recursive: true, force: true });
	rmSync(join(sqlite, 'src'), { recursive: true, force: true });
	const keep = `${process.platform}-${process.arch}.node`;
	for (const prebuild of readdirSync(join(sqlite, 'prebuilds'))) {
		if (prebuild !== keep) {
			rmSync(join(sqlite, 'prebuilds', prebuild));
		}
	}
	if (!existsSync(join(sqlite, 'prebuilds', keep))) {
		fail(`better-sqlite3 has no prebuilt binary ${keep}`);
	}
	rmSync(join(APP, 'package-lock.json'));
	// Only what Node needs to load ES modules; scripts and devDependencies are gone.
	writeFileSync(
		join(APP, 'package.json'),
		`${JSON.stringify({ name: 'bmuster-server', version: serverVersion, private: true, type: 'module', license: 'AGPL-3.0-only' }, null, '\t')}\n`
	);
}

function copyServer(): void {
	cpSync('build', join(APP, 'build'), { recursive: true });
	// connection.ts finds them relative to the working directory, app/.
	const migrations = join('src', 'lib', 'server', 'database', 'migrations');
	cpSync(migrations, join(APP, migrations), { recursive: true });
}

// ---------------------------------------------------------------------------
// Node
// ---------------------------------------------------------------------------

async function download(url: string, path: string): Promise<void> {
	const response = await fetch(url);
	if (!response.ok) {
		fail(`download failed: ${url} (${String(response.status)})`);
	}
	writeFileSync(path, Buffer.from(await response.arrayBuffer()));
}

function sha256(path: string): string {
	return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/** The pinned Node release for this platform, checked against nodejs.org's sums. */
async function addNode(): Promise<void> {
	const base = `https://nodejs.org/dist/v${nodeVersion}`;
	const name = `node-v${nodeVersion}-${spec.node}`;
	const file = `${name}.${platform === 'windows-x64' ? 'zip' : 'tar.xz'}`;
	mkdirSync(CACHE, { recursive: true });
	const archive = join(CACHE, file);
	const sums = join(CACHE, `SHASUMS256-${nodeVersion}.txt`);
	if (!existsSync(sums)) {
		await download(`${base}/SHASUMS256.txt`, sums);
	}
	const expected = readFileSync(sums, 'utf8')
		.split('\n')
		.map((line) => line.trim().split(/\s+/))
		.find(([, listed]) => listed === file)?.[0];
	if (expected === undefined) {
		fail(`${file} is not listed in Node's SHASUMS256.txt`);
	}
	if (!existsSync(archive) || sha256(archive) !== expected) {
		await download(`${base}/${file}`, archive);
	}
	if (sha256(archive) !== expected) {
		fail(`${file} does not match Node's SHASUMS256.txt`);
	}

	const unpacked = join(CACHE, name);
	rmSync(unpacked, { recursive: true, force: true });
	run(TAR, ['-xf', archive, '-C', CACHE]);
	const nodeDir = join(BUNDLE, 'node');
	if (platform === 'windows-x64') {
		mkdirSync(nodeDir, { recursive: true });
		copyFileSync(join(unpacked, 'node.exe'), join(nodeDir, 'node.exe'));
	} else {
		mkdirSync(join(nodeDir, 'bin'), { recursive: true });
		copyFileSync(join(unpacked, 'bin', 'node'), join(nodeDir, 'bin', 'node'));
		chmodSync(join(nodeDir, 'bin', 'node'), 0o755);
	}
	copyFileSync(join(unpacked, 'LICENSE'), join(nodeDir, 'LICENSE'));
	rmSync(unpacked, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Agents and launcher
// ---------------------------------------------------------------------------

/** This computer's agent and launcher, built here: <dir>/<target>/… */
function buildHostBinaries(): string {
	run('cargo', [
		'build',
		'--release',
		'--manifest-path',
		AGENT_MANIFEST,
		'-p',
		'bmuster-agent',
		'-p',
		'bmuster-server'
	]);
	const dir = join(DIST, 'binaries');
	mkdirSync(join(dir, target), { recursive: true });
	for (const name of ['bmuster-agent', 'bmuster-server']) {
		copyFileSync(
			join('agent', 'target', 'release', binaryName(name, target)),
			join(dir, target, binaryName(name, target))
		);
	}
	return dir;
}

/**
 * Agents into releases/<version>/<target>/ (RELEASES_PATH), the launcher at
 * the top. Given binaries must cover every agent target; a local build has
 * this computer's only.
 */
function addBinaries(dir: string, every: boolean): void {
	const version = agentVersion();
	for (const agentTarget of AGENT_TARGETS) {
		const agent = join(dir, agentTarget, binaryName('bmuster-agent', agentTarget));
		if (!existsSync(agent)) {
			if (every) {
				fail(`${agent} is missing; a release carries every agent build`);
			}
			continue;
		}
		const folder = join(BUNDLE, 'releases', version, agentTarget);
		mkdirSync(folder, { recursive: true });
		copyFileSync(agent, join(folder, binaryName('bmuster-agent', agentTarget)));
		chmodSync(join(folder, binaryName('bmuster-agent', agentTarget)), 0o755);
	}
	const launcher = binaryName('bmuster-server', target);
	copyFileSync(join(dir, target, launcher), join(BUNDLE, launcher));
	chmodSync(join(BUNDLE, launcher), 0o755);
}

// ---------------------------------------------------------------------------

rmSync(STAGE, { recursive: true, force: true });
mkdirSync(APP, { recursive: true });

buildServer();
copyServer();
await bundleServerEntry();
installDependencies();
await addNode();
addBinaries(options.binaries ?? buildHostBinaries(), options.binaries !== undefined);
copyFileSync('LICENSE', join(BUNDLE, 'LICENSE'));
writeFileSync(join(BUNDLE, 'VERSION'), `${serverVersion}\n`);

mkdirSync(OUT, { recursive: true });
const archive = join(OUT, `bmuster-server-${platform}.${spec.archive}`);
rmSync(archive, { force: true });
if (spec.archive === 'zip') {
	run(TAR, ['-a', '-c', '-f', archive, '-C', STAGE, 'bmuster-server']);
} else {
	run(TAR, ['-czf', archive, '-C', STAGE, 'bmuster-server']);
}
console.log(
	`release:server: BMuster Server ${serverVersion} for ${platform} (Node ${nodeVersion})`
);
console.log(`  ${archive}`);
console.log(`  SHA-256 ${sha256(archive)}`);

/**
 * npm run agent:dev [-- --url https://localhost:5173] [--name "My laptop"] [--data-dir agent/dev-data]
 *
 * Builds the Rust agent and runs it as you (not root, no service) against the
 * local dev server, with its data in agent/dev-data/ (git-ignored). The first
 * run makes a join code straight in the local database and enrols. Delete
 * agent/dev-data/ to start again. Development only: it accepts the dev
 * server's self-signed certificate.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { hostname } from 'node:os';
import { parseArgs } from 'node:util';
import { openDatabase } from '../src/lib/server/database/connection.ts';
import { env } from '../src/lib/server/env.ts';
import { createJoinCode } from '../src/lib/server/services/agents/join-codes.ts';

const { values } = parseArgs({
	options: {
		url: { type: 'string', default: 'https://localhost:5173' },
		name: { type: 'string', default: `${hostname()} (dev agent)` },
		'data-dir': { type: 'string', default: 'agent/dev-data' }
	}
});

const DATA_DIR = values['data-dir'];
const BINARY = 'agent/target/debug/bmuster-agent';

function run(command: string, args: string[]): void {
	const result = spawnSync(command, args, { stdio: 'inherit' });
	if (result.status !== 0) {
		console.error(`agent:dev: ${command} ${args[0] ?? ''} failed (exit ${String(result.status)})`);
		process.exit(result.status ?? 1);
	}
}

run('cargo', ['build', '--manifest-path', 'agent/Cargo.toml']);

if (!existsSync(`${DATA_DIR}/identity.json`)) {
	const { code } = createJoinCode(
		openDatabase(env.databasePath),
		{ maxUses: 1, minutes: 5, machineGroupIds: [], createdBy: null },
		Date.now()
	);
	console.log(`agent:dev: enrolling with ${values.url} using a fresh join code`);
	run(BINARY, [
		'enrol',
		'--url',
		values.url,
		'--code',
		code,
		'--name',
		values.name,
		'--data-dir',
		DATA_DIR,
		'--insecure-dev-tls'
	]);
}

console.log('agent:dev: running (Ctrl+C to stop)');
run(BINARY, ['run', '--data-dir', DATA_DIR, '--insecure-dev-tls']);

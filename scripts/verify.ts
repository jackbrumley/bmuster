/**
 * Every check in one command (AGENTS.md §8): `npm run verify`.
 *
 * Each check runs as its own process and every check runs even when another
 * fails, so one failure never hides another and nothing is silently skipped.
 * `svelte-kit sync` runs first (the others read what it generates). The checks
 * that use one core each (lint, type check, format, hygiene, dead code,
 * duplication) then run side by side, as many at once as the machine's cores
 * and memory allow; the tests, the build and the Rust agent gate, which use
 * every core themselves, follow one at a time. A check's output is printed as
 * one block when it finishes, then a pass/fail table; the exit code is
 * non-zero when any check failed.
 *
 *   npm run verify                         everything, the gate before a release
 *   npm run verify -- --fast               leaves out the production build
 *                                          (the pre-push hook)
 *   npm run verify -- --skip-if-verified   passes at once when a run already
 *                                          passed on exactly these files
 *                                          (scripts/verify-stamp.ts; the hook)
 *
 * The Rust agent gate (AGENTS.md §14: cargo fmt --check, cargo clippy -- -D
 * warnings, cargo test) runs only once agent/Cargo.toml exists; until then it
 * is reported as skipped, which does not fail the run.
 *
 * Lint uses its cache in --fast runs. The full run lints every file afresh:
 * the cache is keyed on each file's own content, so a type changed in one file
 * can leave a stale result for a file that imports it.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { availableParallelism, totalmem } from 'node:os';
import { passOn, recordPass, workingTreeId } from './verify-stamp.ts';

const KNOWN_FLAGS: ReadonlySet<string> = new Set(['--fast', '--skip-if-verified']);
const flags = process.argv.slice(2);
const unknown = flags.filter((flag) => !KNOWN_FLAGS.has(flag));
if (unknown.length > 0) {
	console.error(
		`[verify] Unknown option(s): ${unknown.join(' ')}. Known: ${[...KNOWN_FLAGS].join(', ')}.`
	);
	process.exit(2);
}
const fast = flags.includes('--fast');
const coverage = fast ? 'fast' : 'full';

const tree = workingTreeId();
if (flags.includes('--skip-if-verified')) {
	const earlier = passOn(tree, coverage);
	if (earlier !== null) {
		console.log(
			`[verify] Skipped: a ${earlier.coverage} verify passed on exactly these files at ${earlier.passedAt}.`
		);
		process.exit(0);
	}
}

/** Where the Rust agent lives (AGENTS.md §14). */
const AGENT_DIR = 'agent';
const hasAgent = existsSync(`${AGENT_DIR}/Cargo.toml`);

interface Check {
	readonly name: string;
	readonly command: string;
	readonly args: readonly string[];
	/** Working directory, relative to the repository root. */
	readonly cwd: string;
	/** Left out of `--fast` runs (the pre-push hook). */
	readonly slow: boolean;
	/** Part of the Rust agent gate: skipped until agent/Cargo.toml exists. */
	readonly agent: boolean;
}

const node = process.execPath;

/** A check run from the repository root. */
function check(name: string, command: string, args: readonly string[], slow = false): Check {
	return { name, command, args, cwd: '.', slow, agent: false };
}

/** A step of the Rust agent gate, run inside agent/. */
function agentCheck(name: string, args: readonly string[]): Check {
	return { name, command: 'cargo', args, cwd: AGENT_DIR, slow: false, agent: true };
}

// Generates .svelte-kit (route types, tsconfig) before anything else: lint
// resolves the `./$types` imports through it, so a stale or missing copy (a
// fresh clone, a pulled route) would fail lint for the wrong reason.
const SYNC = check('svelte-kit sync', 'npx', ['svelte-kit', 'sync']);

/**
 * Lint's cache, in --fast runs only. It lives away from the default
 * `.eslintcache`, which ESLint deletes whenever it runs without --cache. The
 * full run lints every file afresh, over two workers.
 */
const LINT_ARGS = fast
	? ['--cache', '--cache-strategy', 'content', '--cache-location', 'node_modules/.cache/eslint/']
	: ['--concurrency', '2'];

/** Checks that each use about one core: run side by side after SYNC, the slowest first. */
const SIDE_BY_SIDE: readonly Check[] = [
	check('lint', 'npm', ['run', 'lint', '--', ...LINT_ARGS]),
	check('type check', 'npm', ['run', 'check']),
	check('format', 'npm', ['run', 'fmt:check']),
	// `npm run hygiene` chains these with &&, so a hygiene failure would skip
	// the other two: here each runs on its own.
	check('hygiene rules', node, ['scripts/hygiene.ts']),
	check('dead code', 'npm', ['run', 'deadcode']),
	check('duplication', 'npm', ['run', 'duplication'])
];

/**
 * Checks that each use every core (the test workers, the bundler, cargo): one
 * at a time after SIDE_BY_SIDE, since running them together only makes them
 * fight over the processor and memory.
 */
const ONE_AT_A_TIME: readonly Check[] = [
	check('tests', 'npm', ['test']),
	check('production build', 'npm', ['run', 'build'], true),
	agentCheck('agent: cargo fmt', ['fmt', '--check']),
	agentCheck('agent: cargo clippy', ['clippy', '--', '-D', 'warnings']),
	agentCheck('agent: cargo test', ['test'])
];

/**
 * How many SIDE_BY_SIDE checks run at once: half the cores, and no more than
 * one per 3 GB of memory (lint and the type check each hold the whole
 * program).
 */
const SLOTS = Math.max(
	1,
	Math.min(Math.floor(availableParallelism() / 2), Math.floor(totalmem() / 3e9))
);

type Outcome =
	| { readonly status: 'PASS'; readonly seconds: number }
	| { readonly status: 'FAIL'; readonly seconds: number; readonly detail: string }
	| { readonly status: 'SKIPPED'; readonly detail: string };

/** A finished check: its exit code and everything it printed. */
interface Ran {
	readonly code: number;
	readonly output: string;
}

/**
 * Runs one check with its output collected, so checks running side by side
 * never interleave. Colour is kept when verify itself prints to a terminal.
 */
function run(check: Check): Promise<Ran> {
	return new Promise((resolve) => {
		const colour: Record<string, string> = process.stdout.isTTY ? { FORCE_COLOR: '1' } : {};
		const child = spawn(check.command, check.args, {
			cwd: check.cwd,
			stdio: ['ignore', 'pipe', 'pipe'],
			env: { ...process.env, ...colour }
		});
		const chunks: Buffer[] = [];
		child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
		child.stderr.on('data', (chunk: Buffer) => chunks.push(chunk));
		child.on('error', (error) => {
			resolve({ code: 1, output: `[verify] Could not start ${check.command}: ${error.message}` });
		});
		child.on('close', (code, signal) => {
			resolve({
				code: code ?? (signal === null ? 1 : 128),
				output: Buffer.concat(chunks).toString('utf8')
			});
		});
	});
}

function banner(text: string): void {
	const line = '='.repeat(Math.max(60, text.length + 4));
	console.log(`\n${line}\n  ${text}\n${line}\n`);
}

function commandLine(check: Check): string {
	const command = [check.command === node ? 'node' : check.command, ...check.args].join(' ');
	return check.cwd === '.' ? command : `${command}, in ${check.cwd}/`;
}

/** Runs one check (or says why it is not run) and prints its output as one block. */
async function outcomeOf(check: Check): Promise<Outcome> {
	if (fast && check.slow) {
		return { status: 'SKIPPED', detail: '--fast (run the full verify before a release)' };
	}
	if (check.agent && !hasAgent) {
		return { status: 'SKIPPED', detail: `skipped: no ${AGENT_DIR}/ yet` };
	}
	console.log(`[verify] started: ${check.name}`);
	const checkStarted = Date.now();
	const { code, output } = await run(check);
	const seconds = (Date.now() - checkStarted) / 1000;
	banner(
		`${check.name}: ${code === 0 ? 'PASS' : 'FAIL'} in ${seconds.toFixed(1)}s (${commandLine(check)})`
	);
	if (output.trim() !== '') console.log(output.trimEnd());
	return code === 0
		? { status: 'PASS', seconds }
		: { status: 'FAIL', seconds, detail: `exit code ${String(code)}` };
}

const started = Date.now();
const results: { readonly check: Check; readonly outcome: Outcome }[] = [
	{ check: SYNC, outcome: await outcomeOf(SYNC) }
];

console.log(
	`\n[verify] ${String(SIDE_BY_SIDE.length)} checks side by side, ${String(SLOTS)} at a time.`
);
const sideBySide = new Map<Check, Outcome>();
const queue = [...SIDE_BY_SIDE];
await Promise.all(
	Array.from({ length: SLOTS }, async () => {
		for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
			sideBySide.set(next, await outcomeOf(next));
		}
	})
);
// In the order listed, not the order they finished.
for (const listed of SIDE_BY_SIDE) {
	const outcome = sideBySide.get(listed);
	if (outcome === undefined) throw new Error(`[verify] ${listed.name} never ran.`);
	results.push({ check: listed, outcome });
}
for (const next of ONE_AT_A_TIME) {
	results.push({ check: next, outcome: await outcomeOf(next) });
}

const nameWidth = Math.max(...results.map((r) => r.check.name.length));
banner(`verify${fast ? ' --fast' : ''}: results`);
for (const { check: ran, outcome } of results) {
	const time = outcome.status === 'SKIPPED' ? '' : `${outcome.seconds.toFixed(1)}s`;
	const detail = outcome.status === 'PASS' ? '' : outcome.detail;
	console.log(
		`  ${ran.name.padEnd(nameWidth)}  ${outcome.status.padEnd(7)}  ${time.padStart(7)}  ${detail}`
	);
}

const failed = results.filter(({ outcome }) => outcome.status === 'FAIL');
const total = ((Date.now() - started) / 1000).toFixed(0);
if (failed.length > 0) {
	console.error(`\n  FAILED (${total}s): ${failed.map(({ check: f }) => f.name).join(', ')}\n`);
	process.exit(1);
}
console.log(`\n  PASSED (${total}s)\n`);

// Remember the pass, unless files changed while the checks ran (they may have
// seen some of each).
if (workingTreeId() === tree) recordPass(tree, coverage);

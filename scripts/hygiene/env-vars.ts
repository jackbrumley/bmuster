import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import ts from 'typescript';
import type { Report } from './report.ts';
import { isTestFile, type SourceFile } from './source-file.ts';

/**
 * Configuration (AGENTS.md §9): src/lib/server/env.ts is the only reader of
 * process.env, and every variable it reads is listed in `.env.example`, the
 * file an installer copies and fills in.
 *
 * - `env-var-registered`: literal reads (`required("X")`, `optional("X")`,
 *   `process.env.X`, `process.env["X"]`) match the keys in `.env.example`:
 *   nothing read that is not listed, nothing listed that is never read.
 * - `env-direct-access-forbidden`: no code under src/ but env.ts touches
 *   `process.env`. (drizzle.config.ts and vite.config.ts are build config,
 *   outside src/, and read their own variables.)
 */
const ENV_VAR_RULE = 'env-var-registered';
const ENV_DIRECT_ACCESS_RULE = 'env-direct-access-forbidden';

const ENV_EXAMPLE_FILE = '.env.example';
const ENV_MODULE = 'src/lib/server/env.ts';

/**
 * Variables adapter-node reads itself when the server starts (build/index.js):
 * they may be listed in `.env.example` for installers without BMuster code
 * reading them.
 */
const PLATFORM_READ_VARS: ReadonlySet<string> = new Set([
	'PORT',
	'HOST',
	'SOCKET_PATH',
	'ORIGIN',
	'BODY_SIZE_LIMIT',
	'ADDRESS_HEADER',
	'XFF_DEPTH',
	'PROTOCOL_HEADER',
	'HOST_HEADER',
	'PORT_HEADER',
	'SHUTDOWN_TIMEOUT',
	'IDLE_TIMEOUT',
	'KEEP_ALIVE_TIMEOUT',
	'HEADERS_TIMEOUT'
]);

/** The helpers in env.ts that read one variable by name. */
const READERS: ReadonlySet<string> = new Set(['required', 'optional']);
const KEY = /^[A-Z][A-Z0-9_]*$/;

interface EnvAccess {
	readonly reads: readonly { readonly key: string; readonly line: number }[];
	readonly direct: readonly number[];
}

function isProcessEnv(node: ts.Node): boolean {
	return (
		ts.isPropertyAccessExpression(node) &&
		node.name.text === 'env' &&
		ts.isIdentifier(node.expression) &&
		node.expression.text === 'process'
	);
}

/** Literal environment reads and direct `process.env` use in a script. */
function scanEnvAccess(relPath: string, text: string): EnvAccess {
	const source = ts.createSourceFile(relPath, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
	const reads: { key: string; line: number }[] = [];
	const direct: number[] = [];
	const lineOf = (node: ts.Node): number =>
		source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
	const visit = (node: ts.Node): void => {
		if (isProcessEnv(node)) direct.push(lineOf(node));
		if (
			ts.isCallExpression(node) &&
			ts.isIdentifier(node.expression) &&
			READERS.has(node.expression.text)
		) {
			const argument = node.arguments[0];
			if (argument && ts.isStringLiteralLike(argument) && KEY.test(argument.text)) {
				reads.push({ key: argument.text, line: lineOf(node) });
			}
		}
		if (
			ts.isPropertyAccessExpression(node) &&
			isProcessEnv(node.expression) &&
			KEY.test(node.name.text)
		) {
			reads.push({ key: node.name.text, line: lineOf(node) });
		}
		if (
			ts.isElementAccessExpression(node) &&
			isProcessEnv(node.expression) &&
			ts.isStringLiteralLike(node.argumentExpression) &&
			KEY.test(node.argumentExpression.text)
		) {
			reads.push({ key: node.argumentExpression.text, line: lineOf(node) });
		}
		ts.forEachChild(node, visit);
	};
	visit(source);
	return { reads, direct };
}

/** The keys `.env.example` lists (`KEY=value` lines; comments skipped). */
function parseEnvExample(text: string): ReadonlySet<string> {
	const keys = new Set<string>();
	for (const line of text.split('\n')) {
		const match = /^\s*([A-Z][A-Z0-9_]*)\s*=/.exec(line);
		if (match?.[1] !== undefined) keys.add(match[1]);
	}
	return keys;
}

export async function listedEnvVars(workspaceRoot: string): Promise<ReadonlySet<string>> {
	try {
		return parseEnvExample(await readFile(join(workspaceRoot, ENV_EXAMPLE_FILE), 'utf8'));
	} catch {
		return new Set();
	}
}

export function verifyEnvVars(
	files: readonly SourceFile[],
	listed: ReadonlySet<string>,
	report: Report
): void {
	const read = new Set<string>(PLATFORM_READ_VARS);
	for (const file of files) {
		const { relPath } = file;
		if (isTestFile(relPath)) continue;
		const script = file.scriptText();
		if (script === null) continue;
		const { reads, direct } = scanEnvAccess(relPath, script);
		for (const { key, line } of reads) {
			read.add(key);
			if (!listed.has(key)) {
				report(
					ENV_VAR_RULE,
					relPath,
					`Line ${line} reads ${key}, which is not listed in ${ENV_EXAMPLE_FILE}. Add it there with a comment saying what it is.`
				);
			}
		}
		if (relPath === ENV_MODULE) continue;
		for (const line of direct) {
			report(
				ENV_DIRECT_ACCESS_RULE,
				relPath,
				`Line ${line} uses process.env. Add the value to \`env\` in ${ENV_MODULE} and read it from there.`
			);
		}
	}
	for (const key of listed) {
		if (!read.has(key)) {
			report(
				ENV_VAR_RULE,
				ENV_EXAMPLE_FILE,
				`${key} is listed in ${ENV_EXAMPLE_FILE} but nothing reads it. Remove it, or read it in ${ENV_MODULE}.`
			);
		}
	}
}

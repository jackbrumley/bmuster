/**
 * Shared harness for the hygiene rule fixtures: every registered rule has a
 * minimal bad sample that must make it fire and a good sample that must not
 * (tests/unit/hygiene/rule-fixtures.test.ts runs them all and fails when a
 * registered rule has no fixture).
 */
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { runCommand } from '../../../../scripts/hygiene/fs.ts';
import type { Reporter } from '../../../../scripts/hygiene/report.ts';
import type { RuleId } from '../../../../scripts/hygiene/rules.ts';
import { SourceFile } from '../../../../scripts/hygiene/source-file.ts';

/** Runs a check and returns the rule ids it reported, violations and warnings alike. */
type Scenario = () => Promise<readonly RuleId[]>;

export interface RuleFixture {
	readonly rule: RuleId;
	/** A minimal sample the rule must report. */
	readonly bad: Scenario;
	/** A close sample the rule must not report. */
	readonly good: Scenario;
}

/** Collects every rule id a check reports. */
export async function reported(
	run: (reporter: Reporter) => void | Promise<void>
): Promise<RuleId[]> {
	const found: RuleId[] = [];
	await run({
		violation: (rule) => found.push(rule),
		warning: (rule) => found.push(rule)
	});
	return found;
}

/** An in-memory source file. */
export function file(relPath: string, content: string): SourceFile {
	return new SourceFile(relPath, content);
}

/** Fixture files written to a temporary workspace: text, or a symbolic link target. */
export type WorkspaceFiles = Readonly<Record<string, string | { readonly symlinkTo: string }>>;

/** Runs `git` in a directory, failing the test when it fails. */
async function git(dir: string, ...args: string[]): Promise<void> {
	const result = await runCommand(
		'git',
		['-c', 'user.name=Hygiene Fixture', '-c', 'user.email=fixture@example.com', ...args],
		dir
	);
	if (!result.success) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
}

export interface WorkspaceOptions {
	/** Files committed first (needs `git: true`). */
	readonly committed?: WorkspaceFiles;
	/** Make the workspace a git repository. */
	readonly git: boolean;
}

async function writeFiles(root: string, files: WorkspaceFiles): Promise<void> {
	for (const [path, content] of Object.entries(files)) {
		const target = join(root, path);
		await mkdir(dirname(target), { recursive: true });
		await rm(target, { force: true });
		if (typeof content === 'string') await writeFile(target, content);
		else await symlink(content.symlinkTo, target);
	}
}

/**
 * Runs `check` in a temporary workspace holding `files` (after committing
 * `options.committed`), then removes it.
 */
export async function inWorkspace(
	files: WorkspaceFiles,
	options: WorkspaceOptions,
	check: (root: string, reporter: Reporter) => void | Promise<void>
): Promise<RuleId[]> {
	const root = await mkdtemp(join(tmpdir(), 'hygiene-fixture-'));
	try {
		if (options.git) {
			await git(root, 'init', '--quiet');
			if (options.committed) {
				await writeFiles(root, options.committed);
				await git(root, 'add', '--all');
				await git(root, 'commit', '--quiet', '--no-verify', '-m', 'fixture');
			}
		}
		await writeFiles(root, files);
		return await reported((reporter) => check(root, reporter));
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

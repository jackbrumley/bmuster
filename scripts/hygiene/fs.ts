/**
 * File-system and process helpers shared by the hygiene rules.
 */
import { execFile } from 'node:child_process';
import { lstat, readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';

/** Folders never walked: build output and dependencies (the Rust agent builds into target/). */
const SKIPPED_FOLDERS = new Set(['node_modules', '.svelte-kit', 'build', 'target']);

export interface WalkOptions {
	/** Lower-case extensions (with the dot) to keep; every file when omitted. */
	readonly extensions?: ReadonlySet<string>;
	/** Extra folder names to skip anywhere below the root. */
	readonly skipFolders?: ReadonlySet<string>;
}

/** Every regular file below `root` (symlinks are not followed), sorted. */
export async function walkFiles(root: string, options: WalkOptions = {}): Promise<string[]> {
	const files: string[] = [];
	const visit = async (dir: string): Promise<void> => {
		let entries;
		try {
			entries = await readdir(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			const path = join(dir, entry.name);
			if (entry.isDirectory()) {
				if (SKIPPED_FOLDERS.has(entry.name) || options.skipFolders?.has(entry.name) === true)
					continue;
				await visit(path);
			} else if (entry.isFile()) {
				if (options.extensions && !options.extensions.has(extensionOf(entry.name))) continue;
				files.push(path);
			}
		}
	};
	await visit(root);
	return files.sort();
}

/**
 * The lower-case extension including the dot. `+page.svelte` is `.svelte`,
 * `state.svelte.ts` is `.ts`.
 */
export function extensionOf(path: string): string {
	const name = path.slice(path.lastIndexOf('/') + 1);
	const dot = name.lastIndexOf('.');
	return dot <= 0 ? '' : name.slice(dot).toLowerCase();
}

/** Repo-relative path with forward slashes. */
export function repoPath(workspaceRoot: string, absolutePath: string): string {
	return relative(workspaceRoot, absolutePath).replaceAll('\\', '/');
}

export async function pathExists(path: string): Promise<boolean> {
	try {
		await lstat(path);
		return true;
	} catch {
		return false;
	}
}

export interface CommandResult {
	readonly success: boolean;
	readonly code: number;
	readonly stdout: string;
	readonly stderr: string;
}

/**
 * Variables git sets while it runs a hook to say which repository it means.
 * A command run here must work on the repository in its own `cwd`: under the
 * pre-push hook of a worktree, an inherited GIT_DIR made the hygiene
 * fixtures' `git init` re-initialise the real checkout as a bare repository.
 */
const GIT_LOCATION_VARIABLES: ReadonlySet<string> = new Set([
	'GIT_DIR',
	'GIT_WORK_TREE',
	'GIT_INDEX_FILE',
	'GIT_COMMON_DIR',
	'GIT_OBJECT_DIRECTORY',
	'GIT_ALTERNATE_OBJECT_DIRECTORIES',
	'GIT_PREFIX',
	'GIT_NAMESPACE'
]);

/** This process's environment without git's repository-location variables. */
function commandEnvironment(): NodeJS.ProcessEnv {
	return Object.fromEntries(
		Object.entries(process.env).filter(([name]) => !GIT_LOCATION_VARIABLES.has(name))
	);
}

/** Runs a command to completion; never throws (a missing binary is a failure). */
export function runCommand(
	command: string,
	args: readonly string[],
	cwd: string = process.cwd()
): Promise<CommandResult> {
	return new Promise((resolve) => {
		execFile(
			command,
			[...args],
			{ cwd, env: commandEnvironment(), maxBuffer: 64 * 1024 * 1024, encoding: 'utf8' },
			(error, stdout, stderr) => {
				const code = error ? (typeof error.code === 'number' ? error.code : 1) : 0;
				resolve({ success: !error, code, stdout, stderr });
			}
		);
	});
}

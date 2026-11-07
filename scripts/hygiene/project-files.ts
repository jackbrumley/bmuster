import { lstat, readlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { Reporter } from './report.ts';

/** `claude-symlink`: CLAUDE.md is a symbolic link to AGENTS.md, so every agent reads the same rules. */
export async function verifyClaudeSymlink(
	workspaceRoot: string,
	{ violation }: Reporter
): Promise<void> {
	const claudePath = join(workspaceRoot, 'CLAUDE.md');
	let isSymlink: boolean;
	try {
		isSymlink = (await lstat(claudePath)).isSymbolicLink();
	} catch {
		violation(
			'claude-symlink',
			'CLAUDE.md',
			'CLAUDE.md is missing. It must be a symbolic link to AGENTS.md (ln -s AGENTS.md CLAUDE.md).'
		);
		return;
	}
	if (!isSymlink) {
		violation(
			'claude-symlink',
			'CLAUDE.md',
			'CLAUDE.md must be a symbolic link to AGENTS.md so every agent loads the same rules (ln -sf AGENTS.md CLAUDE.md).'
		);
		return;
	}
	const target = await readlink(claudePath);
	if (target !== 'AGENTS.md') {
		violation(
			'claude-symlink',
			'CLAUDE.md',
			`CLAUDE.md links to ${target}, not AGENTS.md (ln -sf AGENTS.md CLAUDE.md).`
		);
	}
}

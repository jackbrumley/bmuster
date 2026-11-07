/**
 * Remembers the exact files a verify run passed on (scripts/verify.ts), so the
 * pre-push hook can skip a second run over the same files: pushing straight
 * after `npm run verify`, or pushing several branches one at a time.
 *
 * The fingerprint is the git tree id of the working tree as it is, uncommitted
 * and untracked files included (ignored files left out), plus the Node
 * version. Any edit, a pulled commit or a different Node gives a new id, so
 * the stamp no longer matches and the checks run.
 */
import { execFileSync } from 'node:child_process';
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { z } from 'zod';

const STAMP_FILE = 'node_modules/.cache/verify/stamp.json';

/** What a passing run covered: `full` includes the production build, `fast` does not. */
export type VerifyCoverage = 'full' | 'fast';

const Stamp = z.object({
	tree: z.string(),
	node: z.string(),
	coverage: z.enum(['full', 'fast']),
	passedAt: z.string()
});
type Stamp = z.infer<typeof Stamp>;

/**
 * The git tree id of the working tree now. Built in a copy of the index, so
 * the real index (what is staged) is never touched.
 */
export function workingTreeId(): string {
	const dir = mkdtempSync(path.join(tmpdir(), 'verify-index-'));
	const index = path.join(dir, 'index');
	const realIndex = execFileSync('git', ['rev-parse', '--git-path', 'index'], {
		encoding: 'utf8'
	}).trim();
	// Starting from the real index lets git reuse its file timestamps instead of
	// hashing every file again.
	if (existsSync(realIndex)) copyFileSync(realIndex, index);
	const env = { ...process.env, GIT_INDEX_FILE: index };
	try {
		execFileSync('git', ['add', '--all'], { env, stdio: 'ignore' });
		return execFileSync('git', ['write-tree'], { env, encoding: 'utf8' }).trim();
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

function readStamp(): Stamp | null {
	if (!existsSync(STAMP_FILE)) return null;
	const parsed = Stamp.safeParse(JSON.parse(readFileSync(STAMP_FILE, 'utf8')));
	return parsed.success ? parsed.data : null;
}

/** The earlier pass on exactly this tree that covers `needed`, or null. */
export function passOn(tree: string, needed: VerifyCoverage): Stamp | null {
	const stamp = readStamp();
	if (stamp?.tree !== tree || stamp.node !== process.version) return null;
	return stamp.coverage === 'full' || needed === 'fast' ? stamp : null;
}

export function recordPass(tree: string, coverage: VerifyCoverage): void {
	const stamp: Stamp = {
		tree,
		node: process.version,
		coverage,
		passedAt: new Date().toISOString()
	};
	mkdirSync(path.dirname(STAMP_FILE), { recursive: true });
	writeFileSync(STAMP_FILE, `${JSON.stringify(stamp, null, '\t')}\n`);
}

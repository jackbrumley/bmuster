/**
 * node scripts/release-notes.ts <tag>
 *
 * Prints the GitHub release body for a tag (vX.Y.Z) from the changelog: what
 * changed and what to test on real machines. Fails when the changelog has no
 * entry for that version. Needs no installed packages, so the release
 * workflow's publish job runs it straight after checkout.
 */
import { CHANGELOG } from '../src/lib/domain/releases/changelog.ts';
import { releaseNotes } from './release/notes.ts';

const tag = process.argv[2] ?? '';
const notes = releaseNotes(tag.startsWith('v') ? tag.slice(1) : tag, CHANGELOG);
if (notes.kind === 'missing') {
	console.error(`::error::${notes.reason}`);
	process.exit(1);
}
process.stdout.write(notes.body);

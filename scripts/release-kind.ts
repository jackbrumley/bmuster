/**
 * npm run release:kind -- <tag>
 *
 * Prints `kind=release` or `kind=prerelease` for a tag (SPEC-TEST-CHANNEL), and
 * appends it to $GITHUB_OUTPUT when the release workflow runs it. Fails with
 * the reason for any other tag. Needs no installed packages, so the
 * workflow's first job can run it straight after checkout.
 */
import { appendFileSync, readFileSync } from 'node:fs';
import { agentVersion } from './agent-build.ts';
import { releaseKind } from './release/kind.ts';

function packageVersion(): string {
	const parsed: unknown = JSON.parse(readFileSync('package.json', 'utf8'));
	if (
		typeof parsed !== 'object' ||
		parsed === null ||
		!('version' in parsed) ||
		typeof parsed.version !== 'string'
	) {
		throw new Error('package.json has no version');
	}
	return parsed.version;
}

const tag = process.argv[2] ?? '';
const result = releaseKind(tag, packageVersion(), agentVersion());
if (result.kind === 'refused') {
	console.error(`::error::${result.reason}`);
	process.exit(1);
}
console.log(`kind=${result.kind}`);
const output = process.env['GITHUB_OUTPUT'];
if (output !== undefined && output !== '') {
	appendFileSync(output, `kind=${result.kind}\nversion=${result.version}\n`);
}

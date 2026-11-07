import {
	checkFilePath,
	checkFileSize,
	verifyGitTrackedFileCasing
} from '../../../../scripts/hygiene/file-layout.ts';
import { checkSvelteParses } from '../../../../scripts/hygiene/source-file.ts';
import { file, inWorkspace, reported, type RuleFixture } from './harness.ts';

const path = (relPath: string) => () =>
	reported((reporter) => {
		checkFilePath(relPath, reporter);
	});

const lines = (count: number): string => Array.from({ length: count }, () => 'x;').join('\n');

const size = (count: number) => () =>
	reported((reporter) => {
		checkFileSize(file('src/lib/utils/example.ts', lines(count)), reporter);
	});

const tracked = (relPath: string) => () =>
	inWorkspace({}, { git: true, committed: { [relPath]: 'x;' } }, (root, reporter) =>
		verifyGitTrackedFileCasing(root, reporter)
	);

export const fileLayoutFixtures: readonly RuleFixture[] = [
	{
		rule: 'naming',
		bad: path('src/lib/ui/UsageBar.svelte'),
		good: path('src/lib/ui/usage-bar.svelte')
	},
	{
		rule: 'naming',
		bad: path('src/routes/(Console)/+page.svelte'),
		good: path('src/routes/(console)/machines/[id=uuid]/+page.svelte')
	},
	{
		rule: 'css-placement',
		bad: path('src/lib/ui/card.css'),
		good: path('src/lib/ui/design-tokens.css')
	},
	{
		rule: 'style-module-file',
		bad: path('src/lib/ui/card-styles.ts'),
		good: path('src/lib/ui/card-state.ts')
	},
	{
		rule: 'artefact',
		bad: path('src/lib/ui/usage-bar-old.svelte'),
		good: path('src/lib/ui/usage-bar-hold.svelte')
	},
	{
		rule: 'lib-root-file-forbidden',
		bad: path('src/lib/helpers.ts'),
		good: path('src/lib/utils/helpers.ts')
	},
	{
		rule: 'lib-root-file-forbidden',
		bad: path('src/lib/terminal/terminal-state.ts'),
		good: path('src/lib/runes/terminal-state.svelte.ts')
	},
	{ rule: 'file-size', bad: size(1001), good: size(1000) },
	{ rule: 'file-size-soft', bad: size(601), good: size(600) },
	{
		rule: 'git-naming-case',
		bad: tracked('src/lib/utils/Format.ts'),
		good: tracked('src/lib/utils/format.ts')
	},
	{
		rule: 'git-naming-case-failed',
		bad: () =>
			inWorkspace({ 'src/lib/utils/format.ts': 'x;' }, { git: false }, (root, reporter) =>
				verifyGitTrackedFileCasing(root, reporter)
			),
		good: () =>
			inWorkspace({ 'src/lib/utils/format.ts': 'x;' }, { git: true }, (root, reporter) =>
				verifyGitTrackedFileCasing(root, reporter)
			)
	},
	{
		rule: 'svelte-parse-error',
		bad: () =>
			reported((reporter) => {
				checkSvelteParses(file('src/lib/ui/card.svelte', '<div>{#if open}</div>'), reporter);
			}),
		good: () =>
			reported((reporter) => {
				checkSvelteParses(
					file('src/lib/ui/card.svelte', '<div>{#if open}<p>Open</p>{/if}</div>'),
					reporter
				);
			})
	}
];

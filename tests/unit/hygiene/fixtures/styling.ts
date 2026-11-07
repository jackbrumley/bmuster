import { checkStyling } from '../../../../scripts/hygiene/styling.ts';
import { file, reported, type RuleFixture } from './harness.ts';

const run = (relPath: string, content: string) => () =>
	reported((reporter) => {
		checkStyling(file(relPath, content), reporter);
	});

const component = (content: string) => run('src/lib/ui/example.svelte', content);

/** Built from a code point so this file holds no raw emoji. */
const CALENDAR_EMOJI = String.fromCodePoint(0x1f4c5);

export const stylingFixtures: readonly RuleFixture[] = [
	{
		rule: 'important-forbidden',
		bad: component('<p>x</p>\n<style>\n\tp { color: var(--text) !important; }\n</style>'),
		good: component('<p>x</p>\n<style>\n\tp { color: var(--text); }\n</style>')
	},
	{
		rule: 'raw-emoji-forbidden',
		bad: component(`<p>${CALENDAR_EMOJI} Activity</p>`),
		good: component('<p>Activity</p>')
	},
	{
		rule: 'hardcoded-color-forbidden',
		bad: component('<p>x</p>\n<style>\n\tp { color: #14201c; }\n</style>'),
		good: component('<p>x</p>\n<style>\n\tp { color: var(--text); }\n</style>')
	},
	{
		rule: 'hardcoded-color-forbidden',
		bad: component(
			'<p>x</p>\n<style>\n\tp { background: light-dark(#ffffff, #161e1b); }\n</style>'
		),
		good: run(
			'src/lib/ui/design-tokens.css',
			':root {\n\t--surface-elevated: light-dark(#ffffff, #161e1b);\n}'
		)
	},
	{
		rule: 'hardcoded-color-forbidden',
		bad: run('src/lib/ui/chart-colours.ts', "export const lineColour = 'rgba(31, 122, 92, 0.12)';"),
		good: run('src/lib/ui/chart-colours.ts', "export const lineColour = 'var(--brand)';")
	},
	{
		rule: 'style-token-required',
		bad: component('<p>x</p>\n<style>\n\tp { margin: 12px; }\n</style>'),
		good: component('<p>x</p>\n<style>\n\tp { margin: var(--space-3); width: 12px; }\n</style>')
	}
];

/**
 * Fixtures for the project-wide rules: input font size, corner radius, page
 * frames, client fetch, environment variables and casts through unknown.
 */
import { verifyInputFontSize } from '../../../../scripts/hygiene/input-font-size.ts';
import { verifyBorderRadius } from '../../../../scripts/hygiene/border-radius.ts';
import { verifyPageFrames } from '../../../../scripts/hygiene/page-frames.ts';
import { verifyPageStructure } from '../../../../scripts/hygiene/page-structure.ts';
import { verifyClientFetch } from '../../../../scripts/hygiene/client-fetch.ts';
import { verifyEnvVars } from '../../../../scripts/hygiene/env-vars.ts';
import { verifyNoDoubleCasts } from '../../../../scripts/hygiene/double-cast.ts';
import type { Report } from '../../../../scripts/hygiene/report.ts';
import type { SourceFile } from '../../../../scripts/hygiene/source-file.ts';
import { file, inWorkspace, reported, type RuleFixture } from './harness.ts';

/** Runs a rule that reads a list of files and reports violations. */
const over =
	(verify: (files: readonly SourceFile[], report: Report) => void, files: readonly SourceFile[]) =>
	() =>
		reported((reporter) => {
			verify(files, reporter.violation);
		});

const PANEL = 'src/routes/(console)/machines/[id]/machine-panel.svelte';
const LOGIN_PAGE = 'src/routes/login/+page.svelte';
const MACHINES_PAGE = 'src/routes/(console)/machines/+page.svelte';
const CONSOLE_LAYOUT = 'src/routes/(console)/+layout.svelte';
/** A page that resets to the root layout, out of the console frame (SPEC-DESKTOP-POPOUT 14). */
const WINDOW_PAGE = 'src/routes/(console)/machines/[id]/desktop/window/+page@.svelte';
const WINDOW_FRAME = 'src/lib/shell/window-frame.svelte';
const SCRIPT = 'src/lib/utils/machine-actions.ts';

const TOKENS = file(
	'src/lib/ui/design-tokens.css',
	':root {\n\t--text-sm: 0.875rem;\n\t--text-base: 1rem;\n}'
);

const fontSize = (content: string) => () =>
	reported((reporter) => {
		verifyInputFontSize([file(PANEL, content)], [TOKENS], reporter.violation);
	});

const TERMINAL = 'src/routes/(console)/machines/[id]/terminal/+page.svelte';

const xtermFontSize = (size: string) => () =>
	reported((reporter) => {
		verifyInputFontSize(
			[
				file(
					TERMINAL,
					`<div class="session"></div>\n<style>\n\t.session :global(.xterm-helper-textarea) { font-size: ${size}; }\n</style>`
				)
			],
			[TOKENS],
			reporter.violation
		);
	});

const appCss = (content: string) => () =>
	reported((reporter) => {
		verifyInputFontSize([], [TOKENS, file('src/app.css', content)], reporter.violation);
	});

const ROLES: ReadonlySet<string> = new Set(['pill', 'control', 'card']);

const radius = (content: string) => () =>
	reported((reporter) => {
		verifyBorderRadius([file(PANEL, content)], ROLES, reporter.violation);
	});

const LISTED: ReadonlySet<string> = new Set(['DATABASE_PATH']);

const env = (relPath: string, content: string) => () =>
	reported((reporter) => {
		verifyEnvVars([file(relPath, content)], LISTED, reporter.violation);
	});

const ENV_MODULE = 'src/lib/server/env.ts';

/** Assembled so this file holds no cast through unknown itself. */
const CAST = ['as', 'unknown', 'as'].join(' ');

const casts = (content: string) => () =>
	inWorkspace({ 'src/lib/utils/machines.ts': content }, { git: false }, (root, reporter) =>
		verifyNoDoubleCasts(root, reporter.violation)
	);

export const projectRuleFixtures: readonly RuleFixture[] = [
	{
		rule: 'input-font-size-ios-zoom',
		bad: fontSize(
			'<input data-raw-input="list-search" class="search" />\n<style>\n\t.search { font-size: var(--text-sm); }\n</style>'
		),
		good: fontSize(
			'<input data-raw-input="list-search" class="search" />\n<style>\n\t.search { font-size: var(--text-base); }\n</style>'
		)
	},
	{
		rule: 'input-font-size-ios-zoom',
		bad: fontSize(
			'<textarea class="notes"></textarea>\n<style>\n\t.notes { font: inherit; }\n</style>'
		),
		good: fontSize(
			'<textarea class="notes"></textarea>\n<style>\n\t.notes { font: inherit; font-size: var(--text-base); }\n</style>'
		)
	},
	{
		rule: 'input-font-size-ios-zoom',
		bad: xtermFontSize('var(--text-sm)'),
		good: xtermFontSize('var(--text-base)')
	},
	{
		rule: 'input-font-size-ios-zoom',
		bad: appCss('input,\ntextarea {\n\tfont-size: var(--text-base);\n}'),
		good: appCss(
			'input,\ntextarea,\nselect,\n[contenteditable] {\n\tfont-size: var(--text-base);\n}'
		)
	},
	{
		rule: 'border-radius-token-required',
		bad: radius('<div class="card"></div>\n<style>\n\t.card { border-radius: 12px; }\n</style>'),
		good: radius(
			'<div class="card"></div>\n<style>\n\t.card { border-radius: var(--radius-card); }\n</style>'
		)
	},
	{
		rule: 'border-radius-token-required',
		bad: radius(
			'<div class="card"></div>\n<style>\n\t.card { border-radius: var(--radius-blob); }\n</style>'
		),
		good: radius(
			'<div class="tab"></div>\n<style>\n\t.tab { border-radius: var(--radius-control) var(--radius-control) 0 0; }\n</style>'
		)
	},
	{
		rule: 'page-frame-required',
		bad: over(verifyPageFrames, [file(LOGIN_PAGE, '<h1>Sign in</h1>')]),
		good: over(verifyPageFrames, [
			file(
				LOGIN_PAGE,
				'<script lang="ts">\n\timport PublicPage from \'#lib/shell/public-page.svelte\';\n</script>\n\n<PublicPage>\n\t<h1>Sign in</h1>\n</PublicPage>'
			)
		])
	},
	{
		rule: 'page-frame-required',
		bad: over(verifyPageFrames, [file(MACHINES_PAGE, '<h1>Machines</h1>')]),
		good: over(verifyPageFrames, [
			file(MACHINES_PAGE, '<h1>Machines</h1>'),
			file(
				CONSOLE_LAYOUT,
				'<script lang="ts">\n\timport ShellFrame from \'#lib/shell/shell-frame.svelte\';\n\tlet { children } = $props();\n</script>\n\n<ShellFrame>{@render children()}</ShellFrame>'
			)
		])
	},
	{
		// SPEC-DESKTOP-POPOUT PO9: a reset page under the console frame is not framed by it.
		rule: 'page-frame-required',
		bad: over(verifyPageFrames, [
			file(WINDOW_PAGE, '<canvas></canvas>'),
			file(
				CONSOLE_LAYOUT,
				'<script lang="ts">\n\timport ShellFrame from \'#lib/shell/shell-frame.svelte\';\n\tlet { children } = $props();\n</script>\n\n<ShellFrame>{@render children()}</ShellFrame>'
			)
		]),
		good: over(verifyPageFrames, [
			file(
				WINDOW_PAGE,
				'<script lang="ts">\n\timport WindowFrame from \'#lib/shell/window-frame.svelte\';\n</script>\n\n<WindowFrame><canvas></canvas></WindowFrame>'
			)
		])
	},
	{
		// SPEC-DESKTOP-POPOUT PO9: WindowFrame is a frame, so it may fill the screen.
		rule: 'page-root-container-forbidden',
		bad: over(verifyPageFrames, [
			file(
				PANEL,
				'<div class="window"></div>\n<style>\n\t.window { min-height: 100dvh; }\n</style>'
			)
		]),
		good: over(verifyPageFrames, [
			file(
				WINDOW_FRAME,
				'<div class="window"></div>\n<style>\n\t.window { min-height: 100dvh; }\n</style>'
			)
		])
	},
	{
		rule: 'route-card-look-forbidden',
		bad: over(verifyPageStructure, [
			file(
				PANEL,
				'<section class="panel"></section>\n<style>\n\t.panel { border: 1px solid var(--border); border-radius: var(--radius-card); }\n</style>'
			)
		]),
		good: over(verifyPageStructure, [
			file(
				PANEL,
				'<div class="screen"></div>\n<style>\n\t.screen { border-radius: var(--radius-card); background: var(--screen-bg); }\n</style>'
			)
		])
	},
	{
		rule: 'route-card-look-forbidden',
		bad: over(verifyPageStructure, [
			file(
				PANEL,
				'<div class="tile"></div>\n<style>\n\t.tile { box-shadow: var(--shadow-card); }\n</style>'
			)
		]),
		good: over(verifyPageStructure, [
			file(
				'src/lib/ui/panel.svelte',
				'<div class="panel"></div>\n<style>\n\t.panel { border: 1px solid var(--border); border-radius: var(--radius-card); box-shadow: var(--shadow-card); }\n</style>'
			)
		])
	},
	{
		rule: 'page-header-required',
		bad: over(verifyPageStructure, [file(MACHINES_PAGE, '<h1>Machines</h1>')]),
		good: over(verifyPageStructure, [
			file(
				MACHINES_PAGE,
				'<script lang="ts">\n\timport PageHeader from \'#lib/ui/page-header.svelte\';\n</script>\n\n<PageHeader title="Machines" summary="All of them." actions={undefined} />'
			),
			file('src/routes/(console)/machines/[id]/notes/+page.svelte', '<p>Notes</p>')
		])
	},
	{
		rule: 'page-root-container-forbidden',
		bad: over(verifyPageFrames, [
			file(PANEL, '<div class="page"></div>\n<style>\n\t.page { min-height: 100svh; }\n</style>')
		]),
		good: over(verifyPageFrames, [
			file(PANEL, '<div class="page"></div>\n<style>\n\t.page { min-height: 100%; }\n</style>')
		])
	},
	{
		rule: 'fixed-edge-safe-area',
		bad: over(verifyPageFrames, [
			file(
				PANEL,
				'<div class="bar"></div>\n<style>\n\t.bar { position: fixed; bottom: var(--space-4); }\n</style>'
			)
		]),
		good: over(verifyPageFrames, [
			file(
				PANEL,
				'<div class="bar"></div>\n<style>\n\t.bar { position: fixed; bottom: calc(var(--space-4) + var(--safe-bottom)); }\n</style>'
			)
		])
	},
	{
		rule: 'fixed-edge-safe-area',
		bad: over(verifyPageFrames, [
			file(
				PANEL,
				'<nav class="tabbar"></nav>\n<style>\n\t.tabbar { position: fixed; bottom: 0; padding-bottom: var(--space-2); }\n</style>'
			)
		]),
		good: over(verifyPageFrames, [
			file(
				PANEL,
				'<nav class="tabbar"></nav>\n<style>\n\t.tabbar { position: fixed; bottom: 0; padding-bottom: var(--safe-bottom); }\n</style>'
			)
		])
	},
	{
		rule: 'client-raw-fetch-forbidden',
		bad: over(verifyClientFetch, [file(SCRIPT, "const response = await fetch('/api/machines');")]),
		good: over(verifyClientFetch, [
			file(
				'src/lib/server/services/agents/agent-updates.ts',
				"const response = await fetch('https://updates.example/latest.json');"
			)
		])
	},
	{
		rule: 'env-var-registered',
		bad: env(ENV_MODULE, "export const env = { secret: required('SESSION_SECRET') };"),
		good: env(ENV_MODULE, "export const env = { databasePath: required('DATABASE_PATH') };")
	},
	{
		rule: 'env-var-registered',
		bad: env(ENV_MODULE, 'export const env = {};'),
		good: env(ENV_MODULE, "export const env = { databasePath: required('DATABASE_PATH') };")
	},
	{
		rule: 'env-direct-access-forbidden',
		bad: env(
			'src/lib/server/database/connection.ts',
			"const path = process.env['DATABASE_PATH'] ?? required('DATABASE_PATH');"
		),
		good: env(
			ENV_MODULE,
			"function required(name: string) { return process.env[name] ?? ''; }\nexport const env = { databasePath: required('DATABASE_PATH') };"
		)
	},
	{
		rule: 'double-cast-forbidden',
		bad: casts(`export const machine = (await response.json()) ${CAST} Machine;`),
		good: casts('export const machine = machineSchema.parse(await response.json());')
	}
];

import { checkCodeStandards } from '../../../../scripts/hygiene/code-standards.ts';
import { file, reported, type RuleFixture } from './harness.ts';

const run = (relPath: string, content: string) => () =>
	reported((reporter) => {
		checkCodeStandards(file(relPath, content), reporter);
	});

const ts = (content: string) => run('src/lib/utils/example.ts', content);
const svelte = (content: string) => run('src/lib/ui/example.svelte', content);

/** Assembled so this file never holds the words the rules look for. */
const LINT_PRAGMA = ['eslint', 'disable'].join('-');
const US_SPELLING = ['organi', 'zation'].join('');

export const codeStandardsFixtures: readonly RuleFixture[] = [
	{
		rule: 'lint-bypass-forbidden',
		bad: ts(`/* ${LINT_PRAGMA} */\nexport const x = 1;`),
		good: ts('// Lint rules apply here.\nexport const x = 1;')
	},
	{
		rule: 'any-type-forbidden',
		bad: svelte('<script lang="ts">\n\tlet value: any = $state(1);\n</script>\n<p>{value}</p>'),
		good: svelte('<script lang="ts">\n\tlet value: number = $state(1);\n</script>\n<p>{value}</p>')
	},
	{
		rule: 'inline-dependencies-forbidden',
		bad: ts("import { z } from 'npm:zod@4.0.0';"),
		good: ts("import { z } from 'zod';")
	},
	{
		rule: 'australian-spelling-violation',
		bad: ts(`export const label = 'Your ${US_SPELLING}';`),
		good: ts("export const label = 'Your organisation';")
	},
	{
		rule: 'redirect-cookie-mutation-forbidden',
		bad: ts(
			"const response = Response.redirect('/login', 303);\nresponse.headers.append('set-cookie', 'session=1');"
		),
		good: ts("cookies.set('session', '1', { path: '/' });\nredirect(303, '/login');")
	},
	{
		rule: 'redirect-header-mutation-forbidden',
		bad: ts(
			"const response = Response.redirect('/login', 303);\nresponse.headers.set('cache-control', 'no-store');"
		),
		good: ts(
			"const response = new Response(null, { status: 303, headers: { location: '/login', 'cache-control': 'no-store' } });"
		)
	},
	{
		rule: 'relative-dynamic-import-forbidden',
		bad: ts("const { load } = await import('./loader.ts');"),
		good: ts("import { load } from '#lib/utils/loader.ts';")
	},
	{
		rule: 'snake-case-url-query-parameter-forbidden',
		bad: ts("const id = url.searchParams.get('machine_id');"),
		good: ts(
			"const id = url.searchParams.get('machineId');\nconst why = url.searchParams.get('error_description');"
		)
	},
	{
		rule: 'raw-html-forbidden',
		bad: svelte(
			'<script lang="ts">\n\tlet { body } = $props();\n</script>\n<div>{@html body}</div>'
		),
		good: svelte('<script lang="ts">\n\tlet { body } = $props();\n</script>\n<div>{body}</div>')
	},
	{
		rule: 'each-block-key-required',
		bad: svelte('{#each machines as machine}<p>{machine.name}</p>{/each}'),
		good: svelte('{#each machines as machine (machine.id)}<p>{machine.name}</p>{/each}')
	}
];

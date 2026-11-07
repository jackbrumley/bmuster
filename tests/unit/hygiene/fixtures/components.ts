/**
 * Fixtures for the component rules: raw-controls.ts,
 * destructive-confirmation.ts, server-boundary.ts and ui-components.ts.
 */
import { checkRawControls } from '../../../../scripts/hygiene/raw-controls.ts';
import { checkDestructiveConfirmation } from '../../../../scripts/hygiene/destructive-confirmation.ts';
import { checkServerImports } from '../../../../scripts/hygiene/server-boundary.ts';
import { checkUiComponents } from '../../../../scripts/hygiene/ui-components.ts';
import { file, reported, type RuleFixture } from './harness.ts';

const COMPONENT = 'src/routes/(console)/machines/[id]/machine-panel.svelte';

const rawControls = (relPath: string, content: string) => () =>
	reported((reporter) => {
		checkRawControls(file(relPath, content), reporter.violation);
	});

const destructive = (content: string) => () =>
	reported((reporter) => {
		checkDestructiveConfirmation(COMPONENT, content, reporter.violation);
	});

const serverImports = (content: string) => () =>
	reported((reporter) => {
		checkServerImports(
			file('src/lib/server/services/agents/agent-service.ts', content),
			reporter.violation
		);
	});

const browserImports = (content: string) => () =>
	reported((reporter) => {
		checkServerImports(file('src/lib/utils/machine-list.ts', content), reporter.violation);
	});

const uiComponents = (content: string) => () =>
	reported((reporter) => {
		checkUiComponents(file(COMPONENT, content), reporter);
	});

export const componentFixtures: readonly RuleFixture[] = [
	{
		rule: 'raw-button-reason-required',
		bad: rawControls(COMPONENT, '<button type="button" onclick={close}>Close</button>'),
		good: rawControls(
			COMPONENT,
			'<button data-raw-button="icon" type="button" aria-label="Close" onclick={close}>x</button>'
		)
	},
	{
		rule: 'raw-button-reason-required',
		bad: rawControls(COMPONENT, '<button data-raw-button="lazy" type="button">Save</button>'),
		good: rawControls(
			'src/lib/ui/button.svelte',
			'<button {type} class="button" {onclick}>{@render children()}</button>'
		)
	},
	{
		rule: 'raw-input-reason-required',
		bad: rawControls(COMPONENT, '<input type="text" bind:value={name} />'),
		good: rawControls(
			COMPONENT,
			'<input data-raw-input="list-search" type="search" bind:value={query} />'
		)
	},
	{
		rule: 'destructive-request-confirmation',
		bad: destructive(
			"<script lang=\"ts\">\n\tasync function remove() {\n\t\tawait api('/api/machines/1', { method: 'DELETE' });\n\t}\n</script>"
		),
		good: destructive(
			"<script lang=\"ts\">\n\tasync function remove() {\n\t\tif (!(await confirmAction({ title: 'Remove machine?' }))) return;\n\t\tawait api('/api/machines/1', { method: 'DELETE' });\n\t}\n</script>"
		)
	},
	{
		rule: 'destructive-request-confirmation',
		bad: destructive(
			'<form method="POST" action="?/revoke"><button type="submit">Revoke</button></form>'
		),
		good: destructive(
			'<form method="POST" action="?/rename"><button type="submit">Rename</button></form>'
		)
	},
	{
		rule: 'server-imports-app-modules-forbidden',
		bad: serverImports(
			"import { env } from '$env/dynamic/private';\nexport const path = env.DATABASE_PATH;"
		),
		good: serverImports(
			"import { env } from '#lib/server/env.ts';\nexport const path = env.databasePath;"
		)
	},
	{
		rule: 'browser-imports-server-forbidden',
		bad: browserImports(
			"import type { machines } from '#lib/server/database/schema.ts';\nexport type Row = typeof machines;"
		),
		good: browserImports(
			"import type { Machine } from '#lib/domain/machines/machine.ts';\nexport const none: Machine[] = [];"
		)
	},
	{
		rule: 'browser-native-dialog-forbidden',
		bad: uiComponents(
			'<script lang="ts">\n\tfunction remove() {\n\t\tif (confirm(\'Remove?\')) void removeMachine();\n\t}\n</script>'
		),
		good: uiComponents(
			'<script lang="ts">\n\tasync function remove() {\n\t\tif (await confirmAction({ title: \'Remove?\' })) void removeMachine();\n\t}\n</script>'
		)
	}
];

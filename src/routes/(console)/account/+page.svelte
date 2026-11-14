<script lang="ts">
	import { roleLabel } from '#lib/domain/users/user.ts';
	import AiAssistantHelp from '#lib/ui/ai-assistant-help.svelte';
	import PageHeader from '#lib/ui/page-header.svelte';
	import Panel from '#lib/ui/panel.svelte';
	import ConnectedAssistants from '../connected-assistants.svelte';
	import TwoFactorPanel from './two-factor-panel.svelte';
	import type { PageProps } from './$types';

	/** Account (SPEC-MCP 8.5, M10): the person's details, two-factor sign-in and connected AI assistants. */
	let { data }: PageProps = $props();
</script>

<PageHeader
	title="Account"
	summary="Your details, two-factor sign-in, and the AI assistants connected as you."
	actions={undefined}
/>

<Panel heading="Your details" actions={undefined} tone="normal" padding="normal">
	<dl class="facts">
		<dt>Name</dt>
		<dd>{data.user.name}</dd>
		<dt>Email</dt>
		<dd>{data.user.email}</dd>
		<dt>Role</dt>
		<dd>{roleLabel(data.user.role)}</dd>
		<dt>Signs in with</dt>
		<dd>{data.signIn.length === 0 ? 'Nothing yet' : data.signIn.join(', ')}</dd>
	</dl>
</Panel>

<TwoFactorPanel
	status={data.twoFactor}
	email={data.user.email}
	origin={data.origin}
	now={data.now}
/>

<ConnectedAssistants grants={data.grants} now={data.now} showPerson={false} />

<AiAssistantHelp serverUrl={data.serverUrl} state={data.connect} />

<style>
	.facts {
		display: grid;
		grid-template-columns: max-content minmax(0, 1fr);
		gap: var(--space-2) var(--space-4);
		font-size: var(--text-sm);
	}

	dt {
		color: var(--muted);
	}

	dd {
		overflow-wrap: anywhere;
	}
</style>

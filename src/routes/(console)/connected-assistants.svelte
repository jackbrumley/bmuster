<script lang="ts">
	import { refreshAll } from '$app/navigation';
	import { IconPlugConnected } from '@tabler/icons-svelte-runes';
	import { assistantLabel, type GrantView } from '#lib/domain/mcp/mcp.ts';
	import { disconnectedReplySchema } from '#lib/schemas/mcp/console.ts';
	import Button from '#lib/ui/button.svelte';
	import { confirmAction } from '#lib/ui/confirm-action.svelte.ts';
	import ListCard from '#lib/ui/list-card.svelte';
	import ListRow from '#lib/ui/list-row.svelte';
	import { showToast } from '#lib/ui/toast.svelte.ts';
	import { apiRequest } from '#lib/utils/api-client.ts';
	import { formatRelative } from '#lib/utils/format.ts';

	/**
	 * Connected AI assistants with Disconnect (SPEC-MCP M10): a person's own on the Account page,
	 * everyone's on Settings → AI assistants (`showPerson` names whose each one is).
	 */
	let {
		grants,
		now,
		showPerson
	}: { grants: readonly GrantView[]; now: number; showPerson: boolean } = $props();

	async function disconnect(grant: GrantView): Promise<void> {
		const name = assistantLabel(grant.assistant);
		const yes = await confirmAction({
			title: `Disconnect ${name}?`,
			message: `${name} loses access to BMuster straight away. To use it again, connect it again.`,
			confirmLabel: 'Disconnect'
		});
		if (!yes) {
			return;
		}
		const result = await apiRequest({
			method: 'DELETE',
			url: `/api/mcp/grants/${grant.id}`,
			body: undefined,
			reply: disconnectedReplySchema
		});
		showToast(
			result.ok ? `${name} is disconnected.` : result.message,
			result.ok ? 'success' : 'error'
		);
		await refreshAll();
	}
</script>

{#snippet grantRow(grant: GrantView)}
	<ListRow action={{ kind: 'static' }} align="start" dimmed={false}>
		<span class="icon"><IconPlugConnected size={20} /></span>
		<span class="body">
			<span class="name">
				{grant.assistant.name}
				{#if grant.active}<span class="active">Active now</span>{/if}
			</span>
			<span class="meta">
				{grant.assistant.identity.kind === 'verified'
					? `Verified: ${grant.assistant.identity.host}`
					: 'Unverified: it named itself'}
				{#if showPerson}· as {grant.userName}{/if}
			</span>
			<span class="meta">
				Connected {formatRelative(grant.createdIso, now)} · {grant.lastUsed.kind === 'used'
					? `last used ${formatRelative(grant.lastUsed.atIso, now)} from ${grant.lastUsed.ip}`
					: 'not used yet'}
			</span>
		</span>
		<Button variant="danger" size="compact" type="button" onclick={() => void disconnect(grant)}>
			Disconnect
		</Button>
	</ListRow>
{/snippet}

<ListCard
	heading="Connected AI assistants"
	actions={undefined}
	label="Connected AI assistants, newest first"
	items={grants}
	key={(grant: GrantView) => grant.id}
	row={grantRow}
	empty="No AI assistant is connected."
/>

<style>
	.icon {
		display: inline-flex;
		flex-shrink: 0;
		padding-top: var(--space-0-5);
		color: var(--brand);
	}

	.body {
		display: grid;
		flex: 1;
		gap: var(--space-0-5);
		min-width: 0;
	}

	.name {
		font-weight: var(--weight-semibold);
		overflow-wrap: anywhere;
	}

	.active {
		margin-left: var(--space-2);
		padding: 0 var(--space-2);
		border-radius: var(--radius-pill);
		background: var(--success-bg);
		color: var(--success);
		font-size: var(--text-xs);
		font-weight: var(--weight-medium);
	}

	.meta {
		color: var(--muted);
		font-size: var(--text-xs);
		overflow-wrap: anywhere;
	}
</style>

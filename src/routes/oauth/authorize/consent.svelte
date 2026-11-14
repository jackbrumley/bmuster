<script lang="ts">
	import { IconPlugConnected, IconShieldCheck } from '@tabler/icons-svelte-runes';
	import {
		scopeLabel,
		type AssistantName,
		type McpScope,
		type RedirectTarget
	} from '#lib/domain/mcp/mcp.ts';
	import Button from '#lib/ui/button.svelte';
	import Notice from '#lib/ui/notice.svelte';

	/**
	 * What a person sees before an AI assistant may act as them (SPEC-MCP M7, 8.3): which assistant,
	 * whether BMuster can vouch for its name, where the browser goes back to, and what it may do.
	 * Allow and Cancel post the request back; the server checks it all again.
	 */
	type View =
		| { kind: 'invalid'; message: string }
		| { kind: 'not-allowed'; assistant: AssistantName }
		| { kind: 'ask'; assistant: AssistantName; redirect: RedirectTarget; scopes: McpScope[] };

	let {
		view,
		fields,
		userName,
		outcome
	}: {
		view: View;
		fields: { name: string; value: string }[];
		userName: string;
		/** What the last Allow or Cancel came back with, when it did not leave the page. */
		outcome: { kind: 'none' } | { kind: 'refused'; message: string };
	} = $props();
</script>

{#snippet hidden()}
	{#each fields as field (field.name)}
		<input type="hidden" name={field.name} value={field.value} />
	{/each}
{/snippet}

{#snippet cancelForm()}
	<form method="POST" action="?/cancel">
		{@render hidden()}
		<Button variant="secondary" size="large" type="submit" onclick={undefined}>Cancel</Button>
	</form>
{/snippet}

<div class="consent">
	{#if outcome.kind === 'refused'}
		<p class="problem" role="alert">{outcome.message}</p>
	{/if}

	{#if view.kind === 'invalid'}
		<h1>This connection request cannot be used</h1>
		<p class="lead">{view.message}</p>
		<p class="lead">Start connecting again from your AI assistant.</p>
	{:else if view.kind === 'not-allowed'}
		<h1>You cannot connect an AI assistant</h1>
		<p class="lead">
			{view.assistant.name} asked to act as you, but you are not in the group of people who may connect
			one. Ask an admin to add you to it.
		</p>
		<div class="actions">{@render cancelForm()}</div>
	{:else}
		<span class="badge"><IconPlugConnected size={28} /></span>
		<h1><span class="name">{view.assistant.name}</span> wants to act as you on BMuster</h1>
		<p class="lead">Signed in as {userName}.</p>

		{#if view.assistant.identity.kind === 'verified'}
			<p class="verified">
				<IconShieldCheck size={18} />
				Its details come from <strong>{view.assistant.identity.host}</strong>.
			</p>
		{:else}
			<Notice tone="warning" title="Unverified assistant">
				<p>
					It named itself “{view.assistant.name}”. BMuster cannot confirm who made it. Allow it only
					if you just started connecting it yourself.
				</p>
			</Notice>
		{/if}

		{#if view.redirect.kind === 'loopback'}
			<Notice tone="warning" title="Returns to a program on this computer">
				<p>Allow it only if you started connecting from a program on this computer.</p>
			</Notice>
		{:else}
			<p class="detail">Afterwards you go back to <strong>{view.redirect.host}</strong>.</p>
		{/if}

		<h2>It may</h2>
		<ul class="scopes">
			{#each view.scopes as scope (scope)}
				<li>{scopeLabel(scope)}</li>
			{/each}
		</ul>

		<p class="detail">
			<strong>It acts as you. Every command still needs a person's approval in BMuster.</strong>
		</p>
		<p class="detail">
			The assistant's provider receives what it reads. You can disconnect it at any time from your
			Account page.
		</p>

		<div class="actions">
			{@render cancelForm()}
			<form method="POST" action="?/allow">
				{@render hidden()}
				<Button variant="primary" size="large" type="submit" onclick={undefined}>Allow</Button>
			</form>
		</div>
	{/if}
</div>

<style>
	.consent {
		display: grid;
		gap: var(--space-4);
		min-width: 0;
		overflow-wrap: anywhere;
	}

	.badge {
		display: inline-flex;
		justify-self: center;
		align-items: center;
		justify-content: center;
		width: 56px;
		height: 56px;
		border-radius: var(--radius-round);
		background: var(--brand-tint);
		color: var(--brand);
	}

	h1 {
		font-size: var(--text-xl);
		font-weight: var(--weight-bold);
		text-align: center;
	}

	h2 {
		font-size: var(--text-sm);
		font-weight: var(--weight-semibold);
	}

	.name {
		color: var(--brand);
	}

	.lead {
		color: var(--muted);
		font-size: var(--text-sm);
		text-align: center;
	}

	.verified {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		color: var(--success);
		font-size: var(--text-sm);
	}

	.detail {
		font-size: var(--text-sm);
	}

	.scopes {
		display: grid;
		gap: var(--space-2);
		padding-left: var(--space-5);
		font-size: var(--text-sm);
		list-style: disc;
	}

	.actions {
		display: grid;
		grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
		gap: var(--space-3);
	}

	.actions:has(> form:only-child) {
		grid-template-columns: minmax(0, 1fr);
	}

	.problem {
		padding: var(--space-3);
		border-radius: var(--radius-control);
		background: var(--danger-bg);
		color: var(--danger);
		font-size: var(--text-sm);
	}
</style>

<script lang="ts">
	import { IconKey, IconPlus, IconShieldCheck } from '@tabler/icons-svelte-runes';
	import PageHeader from '#lib/ui/page-header.svelte';
	import { formatRelative } from '#lib/utils/format.ts';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	function groupNames(ids: string[]): string {
		const names = data.userGroups
			.filter((group) => ids.includes(group.id))
			.map((group) => group.name);
		return names.length === 0 ? 'No groups' : names.join(', ');
	}
</script>

<PageHeader title="Users" summary="People who can sign in to this console.">
	{#snippet actions()}
		<button type="button" class="primary"><IconPlus size={18} /> Add user</button>
	{/snippet}
</PageHeader>

<ul class="list">
	{#each data.users as user (user.id)}
		<li class="row">
			<span class="avatar">{user.name.slice(0, 1)}</span>
			<div class="body">
				<p class="name">
					{user.name}
					{#if user.role === 'admin'}
						<span class="badge"><IconShieldCheck size={14} /> Admin</span>
					{/if}
				</p>
				<p class="meta">{user.email}</p>
				<p class="meta">{groupNames(user.userGroupIds)}</p>
			</div>
			<div class="side">
				<span class="method">
					{#if user.signIn.kind === 'password'}
						<IconKey size={14} /> Password
					{:else}
						{user.signIn.providerName}
					{/if}
				</span>
				<span class="meta">{formatRelative(user.lastSignInIso, data.now)}</span>
			</div>
		</li>
	{/each}
</ul>

<style>
	.primary {
		display: inline-flex;
		align-items: center;
		gap: var(--space-2);
		padding: var(--space-2) var(--space-4);
		border: none;
		border-radius: var(--radius-pill);
		background: var(--brand);
		color: var(--brand-contrast);
		font-size: var(--text-sm);
		font-weight: var(--weight-semibold);
		cursor: pointer;
	}

	.list {
		margin: 0;
		padding: 0;
		list-style: none;
		border: 1px solid var(--border);
		border-radius: var(--radius-card);
		background: var(--surface-elevated);
		overflow: hidden;
	}

	.row {
		display: flex;
		align-items: flex-start;
		gap: var(--space-3);
		padding: var(--space-4);
	}

	.row + .row {
		border-top: 1px solid var(--border);
	}

	.avatar {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 40px;
		height: 40px;
		flex-shrink: 0;
		border-radius: var(--radius-round);
		background: var(--brand-tint);
		color: var(--brand);
		font-weight: var(--weight-bold);
	}

	.body {
		flex: 1;
		min-width: 0;
	}

	.name {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-2);
		font-weight: var(--weight-semibold);
	}

	.badge {
		display: inline-flex;
		align-items: center;
		gap: var(--space-1);
		padding: 0 var(--space-2);
		border-radius: var(--radius-pill);
		background: var(--warning-bg);
		color: var(--warning);
		font-size: var(--text-xs);
	}

	.meta {
		color: var(--muted);
		font-size: var(--text-xs);
	}

	.side {
		display: grid;
		justify-items: end;
		gap: var(--space-1);
		flex-shrink: 0;
	}

	.method {
		display: inline-flex;
		align-items: center;
		gap: var(--space-1);
		padding: 2px var(--space-2);
		border-radius: var(--radius-pill);
		background: var(--surface-muted);
		color: var(--text-soft);
		font-size: var(--text-xs);
	}
</style>

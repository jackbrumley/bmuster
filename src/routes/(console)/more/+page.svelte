<script lang="ts">
	import { resolve } from '$app/paths';
	import { IconChevronRight } from '@tabler/icons-svelte-runes';
	import { adminNav } from '#lib/shell/console-nav.ts';
	import SignedInUser from '#lib/shell/signed-in-user.svelte';
	import PageHeader from '#lib/ui/page-header.svelte';

	/** Phones only: what the sidebar shows below the main links. */
	const admin = adminNav();
</script>

<PageHeader title="More" summary="Administration and your account." actions={undefined} />

<ul class="list">
	{#each admin as item (item.route)}
		<li>
			<a class="row" href={resolve(item.route)}>
				<item.icon size={22} stroke={1.75} />
				<span class="label">{item.label}</span>
				<IconChevronRight size={18} />
			</a>
		</li>
	{/each}
</ul>

<section class="account">
	<SignedInUser name="Jack Brumley" role="Admin" />
</section>

<style>
	.list {
		margin: 0 0 var(--space-4);
		padding: 0;
		list-style: none;
		border: 1px solid var(--border);
		border-radius: var(--radius-card);
		background: var(--surface-elevated);
		overflow: hidden;
	}

	li + li {
		border-top: 1px solid var(--border);
	}

	.row {
		display: flex;
		align-items: center;
		gap: var(--space-3);
		min-height: 56px;
		padding: 0 var(--space-4);
		color: var(--text-soft);
	}

	.label {
		flex: 1;
		color: var(--text);
		font-weight: var(--weight-medium);
	}

	.account {
		padding: var(--space-4);
		border: 1px solid var(--border);
		border-radius: var(--radius-card);
		background: var(--surface-elevated);
	}
</style>

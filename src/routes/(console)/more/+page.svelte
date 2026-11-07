<script lang="ts">
	import { resolve } from '$app/paths';
	import { IconChevronRight } from '@tabler/icons-svelte-runes';
	import { adminNav, type NavItem } from '#lib/shell/console-nav.ts';
	import SignedInUser from '#lib/shell/signed-in-user.svelte';
	import ListCard from '#lib/ui/list-card.svelte';
	import ListRow from '#lib/ui/list-row.svelte';
	import PageHeader from '#lib/ui/page-header.svelte';
	import Panel from '#lib/ui/panel.svelte';
	import type { PageProps } from './$types';

	/** Phones only: what the sidebar shows below the main links. The layout proved who this is. */
	let { data }: PageProps = $props();

	const admin = $derived(adminNav(data.user.role));
</script>

<PageHeader title="More" summary="Administration and your account." actions={undefined} />

{#snippet navRow(item: NavItem)}
	<ListRow action={{ kind: 'link', href: resolve(item.route) }} align="center" dimmed={false}>
		<span class="icon"><item.icon size={22} stroke={1.75} /></span>
		<span class="label">{item.label}</span>
		<IconChevronRight size={18} />
	</ListRow>
{/snippet}

{#if admin.length > 0}
	<ListCard
		heading="Administration"
		actions={undefined}
		label="Administration"
		items={admin}
		key={(item: NavItem) => item.route}
		row={navRow}
		empty="Nothing to administer."
	/>
{/if}

<Panel heading="Your account" actions={undefined} tone="normal" padding="normal">
	<SignedInUser user={data.user} />
</Panel>

<style>
	.icon {
		display: inline-flex;
		color: var(--text-soft);
	}

	.label {
		flex: 1;
		font-weight: var(--weight-medium);
	}
</style>

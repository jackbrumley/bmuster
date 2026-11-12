<script lang="ts">
	import { onMount } from 'svelte';
	import { resolve } from '$app/paths';
	import {
		sharePermissionsLabel,
		timeLeftLabel,
		type ShareLinkView
	} from '#lib/domain/share-links/share-links.ts';
	import { endShareLinkReplySchema } from '#lib/schemas/share-links/share-links.ts';
	import Button from '#lib/ui/button.svelte';
	import { confirmAction } from '#lib/ui/confirm-action.svelte.ts';
	import ListCard from '#lib/ui/list-card.svelte';
	import ListRow from '#lib/ui/list-row.svelte';
	import { showToast } from '#lib/ui/toast.svelte.ts';
	import { apiRequest } from '#lib/utils/api-client.ts';

	/**
	 * Every active share link on the server, for admins (SPEC-SHARE-LINKS
	 * SL15): which machine, who for, what, by whom, time left, and End now.
	 */
	let { links, loadedAtMs }: { links: ShareLinkView[]; loadedAtMs: number } = $props();

	let ticking = $state<number | undefined>(undefined);
	let endedIds = $state<string[]>([]);
	const now = $derived(ticking ?? loadedAtMs);
	const shown = $derived(
		links.filter((link) => !endedIds.includes(link.id) && Date.parse(link.expiresIso) > now)
	);

	onMount(() => {
		const clock = setInterval(() => {
			ticking = Date.now();
		}, 1000);
		return () => {
			clearInterval(clock);
		};
	});

	async function endNow(link: ShareLinkView): Promise<void> {
		const yes = await confirmAction({
			title: `End the link for ${link.recipient}?`,
			message: `The link to ${link.machineName} stops working at once, and anyone connected with it is disconnected.`,
			confirmLabel: 'End now'
		});
		if (!yes) {
			return;
		}
		const result = await apiRequest({
			method: 'DELETE',
			url: resolve('/api/share-links/[id=uuid]', { id: link.id }),
			body: undefined,
			reply: endShareLinkReplySchema
		});
		if (!result.ok) {
			showToast(result.message, 'error');
			return;
		}
		endedIds = [...endedIds, link.id];
		showToast(`The link for ${link.recipient} has ended.`, 'success');
	}
</script>

{#snippet linkRow(link: ShareLinkView)}
	<ListRow action={{ kind: 'static' }} align="center" dimmed={false}>
		<div class="link">
			<p class="who">{link.recipient} · {link.machineName}</p>
			<p class="what">
				{sharePermissionsLabel(link.permissions)} · by {link.createdByName} · {timeLeftLabel(
					Date.parse(link.expiresIso),
					now
				)} left
			</p>
		</div>
		<Button variant="secondary" size="compact" type="button" onclick={() => void endNow(link)}
			>End now</Button
		>
	</ListRow>
{/snippet}

<ListCard
	heading="Active share links"
	actions={undefined}
	label="Active share links on every machine"
	items={shown}
	key={(link: ShareLinkView) => link.id}
	row={linkRow}
	empty="No share links are active."
/>

<style>
	.link {
		flex: 1;
		min-width: 0;
	}

	.who {
		font-weight: var(--weight-semibold);
		overflow-wrap: anywhere;
	}

	.what {
		color: var(--muted);
		font-size: var(--text-sm);
	}
</style>

<script lang="ts">
	import { onMount } from 'svelte';
	import { resolve } from '$app/paths';
	import { IconClock, IconLinkOff } from '@tabler/icons-svelte-runes';
	import {
		sharePermissionsLabel,
		timeLeftLabel,
		type GuestView
	} from '#lib/domain/share-links/share-links.ts';
	import { guestStatusReplySchema } from '#lib/schemas/share-links/share-links.ts';
	import PublicPage from '#lib/shell/public-page.svelte';
	import EmptyState from '#lib/ui/empty-state.svelte';
	import { apiRequest } from '#lib/utils/api-client.ts';
	import GuestDesktop from './guest-desktop.svelte';

	/**
	 * The guest page (SPEC-SHARE-LINKS SL18): no console, just the shared
	 * machine's screen, who shared it, when it ends and a countdown. The page
	 * asks the server every 30 seconds whether the link still works, so an
	 * ended link (End now, its creator losing access) shows at once as ended.
	 */
	let { token, guest, loadedAtMs }: { token: string; guest: GuestView; loadedAtMs: number } =
		$props();

	/** The server's clock, as the countdown reads it: the browser's may be off. */
	let ticking = $state<number | undefined>(undefined);
	const now = $derived(ticking ?? loadedAtMs);
	let endedByServer = $state(false);

	const expiresMs = $derived(Date.parse(guest.expiresIso));
	const ended = $derived(endedByServer || now >= expiresMs);
	const endsAt = $derived(
		new Date(expiresMs).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
	);

	async function checkStatus(): Promise<void> {
		const result = await apiRequest({
			method: 'GET',
			url: resolve('/s/[token]/status', { token }),
			body: undefined,
			reply: guestStatusReplySchema
		});
		if (!result.ok && result.status === 404) {
			endedByServer = true;
		}
	}

	onMount(() => {
		const offset = loadedAtMs - Date.now();
		const clock = setInterval(() => {
			ticking = Date.now() + offset;
		}, 1000);
		const poll = setInterval(() => {
			if (!ended) {
				void checkStatus();
			}
		}, 30_000);
		return () => {
			clearInterval(clock);
			clearInterval(poll);
		};
	});
</script>

<PublicPage width="wide">
	{#if ended}
		<EmptyState
			icon={IconLinkOff}
			title="This link has ended"
			detail="Ask the person who sent it for a new one if you still need access."
			children={undefined}
		/>
	{:else}
		<div class="guest">
			<header class="head">
				<h1>{guest.machineName}</h1>
				<p class="banner" role="note">
					Shared by {guest.sharedByName} · ends {endsAt}
				</p>
				<p class="facts">
					For {guest.recipient} · {sharePermissionsLabel(guest.permissions)}
				</p>
				<p class="countdown" role="timer" aria-live="off">
					<IconClock size={16} /> Ends in {timeLeftLabel(expiresMs, now)}
				</p>
			</header>
			<GuestDesktop
				{token}
				machineName={guest.machineName}
				osFamily={guest.osFamily}
				canControl={guest.permissions.includes('desktop-control')}
			/>
			<p class="note">
				The person at this computer is asked before you connect and can see that you are connected.
				Everything is recorded.
			</p>
		</div>
	{/if}
</PublicPage>

<style>
	.guest {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: var(--space-4);
	}

	.head {
		display: grid;
		gap: var(--space-1);
	}

	h1 {
		font-size: var(--text-2xl);
		font-weight: var(--weight-bold);
		overflow-wrap: anywhere;
	}

	.banner {
		color: var(--brand);
		font-weight: var(--weight-semibold);
	}

	.facts,
	.note {
		color: var(--muted);
		font-size: var(--text-sm);
		overflow-wrap: anywhere;
	}

	.countdown {
		display: inline-flex;
		align-items: center;
		gap: var(--space-1);
		color: var(--text-soft);
		font-size: var(--text-sm);
		font-variant-numeric: tabular-nums;
	}
</style>

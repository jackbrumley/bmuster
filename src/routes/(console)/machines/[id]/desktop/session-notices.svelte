<script lang="ts">
	import type { Connection } from '#lib/runes/session-link.svelte.ts';
	import Button from '#lib/ui/button.svelte';
	import Notice from '#lib/ui/notice.svelte';
	import PoppedOutNotice from './popped-out-notice.svelte';

	/**
	 * The notices above the desktop tab's screen: how the session ended, where
	 * it moved to (this tab's pop-out window or another tab), the agent's last
	 * problem and a paused picture.
	 */
	let {
		connection,
		running,
		poppedOut,
		popOutClosed,
		problem,
		stalled,
		onbringback,
		onclosepopout,
		ontakeback,
		onresume
	}: {
		connection: Connection;
		running: boolean;
		/** The session moved to the window this tab opened. */
		poppedOut: boolean;
		popOutClosed: boolean;
		problem: string | undefined;
		stalled: boolean;
		onbringback: () => void;
		onclosepopout: () => void;
		ontakeback: () => void;
		onresume: () => void;
	} = $props();
</script>

{#if connection.kind === 'ended'}
	<Notice tone="info" title={connection.message} children={undefined} />
{:else if poppedOut}
	<PoppedOutNotice closed={popOutClosed} {onbringback} onclose={onclosepopout} />
{:else if connection.kind === 'moved'}
	<Notice tone="info" title="This session is open in another window or tab.">
		<div class="actions">
			<Button variant="primary" size="compact" type="button" onclick={ontakeback}
				>Use it here</Button
			>
		</div>
	</Notice>
{/if}

{#if problem !== undefined && running}
	<Notice tone="warning" title={problem} children={undefined} />
{/if}

{#if stalled && running}
	<Notice tone="warning" title="The picture is paused: frames were not getting through.">
		<div class="actions">
			<Button variant="secondary" size="compact" type="button" onclick={onresume}>Resume</Button>
		</div>
	</Notice>
{/if}

<style>
	.actions {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-2);
		margin-top: var(--space-2);
	}
</style>

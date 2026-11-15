<script lang="ts">
	import Button from '#lib/ui/button.svelte';
	import Notice from '#lib/ui/notice.svelte';
	import FilesWaiting from './files-waiting.svelte';
	import PoppedOutNotice from './popped-out-notice.svelte';
	import type { MovedNotice, SessionChrome } from './session-chrome.svelte.ts';

	/**
	 * The session's notices, in every desktop view (SPEC-DESKTOP 23): how it
	 * ended, where it moved to, files copied on the machine, the agent's last
	 * problem, a paused picture, and why a drop was refused. Above the screen
	 * in the page; over it in full screen and the pop-out, where there is no
	 * bar status, a dropped connection says Reconnecting too.
	 */

	let {
		chrome,
		over,
		moved,
		refused
	}: {
		chrome: SessionChrome;
		/** Shown over the screen, where no bar shows the status. */
		over: boolean;
		moved: MovedNotice;
		/** Why a dropped file was not sent, once one was. */
		refused: string | undefined;
	} = $props();

	const connection = $derived(chrome.connection);
	const running = $derived(chrome.running);
</script>

{#if connection.kind === 'ended'}
	<Notice tone="info" title={connection.message} children={undefined} />
{:else if connection.kind === 'moved' && moved.kind === 'popped-out'}
	<PoppedOutNotice closed={moved.closed} onbringback={moved.onbringback} onclose={moved.onclose} />
{:else if connection.kind === 'moved'}
	<Notice
		tone="info"
		title={moved.kind === 'window'
			? 'This session is back in another window or tab.'
			: 'This session is open in another window or tab.'}
	>
		<div class="actions">
			<Button
				variant="primary"
				size="compact"
				type="button"
				onclick={() => void chrome.session?.takeBack()}>Use it here</Button
			>
			{#if moved.kind === 'window'}
				<Button variant="secondary" size="compact" type="button" onclick={moved.onclose}
					>Close window</Button
				>
			{/if}
		</div>
	</Notice>
{:else if over && connection.kind === 'reconnecting'}
	<Notice tone="warning" title="Reconnecting to the machine…" children={undefined} />
{/if}

{#if refused !== undefined}
	<Notice tone="info" title={refused} children={undefined} />
{/if}

{#if chrome.waitingNotice !== undefined}
	<FilesWaiting
		waiting={chrome.waitingNotice}
		onputaway={() => {
			chrome.putAwayWaiting();
		}}
	/>
{/if}

{#if chrome.session?.problem !== undefined && running}
	<Notice tone="warning" title={chrome.session.problem} children={undefined} />
{/if}

{#if chrome.session?.stalled === true && running}
	<Notice tone="warning" title="The picture is paused: frames were not getting through.">
		<div class="actions">
			<Button
				variant="secondary"
				size="compact"
				type="button"
				onclick={() => chrome.session?.requestKeyframe()}>Resume</Button
			>
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

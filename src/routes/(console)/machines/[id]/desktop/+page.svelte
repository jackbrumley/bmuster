<script lang="ts">
	import {
		IconArrowsMaximize,
		IconDeviceDesktop,
		IconKeyboard,
		IconPlugConnected,
		IconPointer,
		IconHandFinger
	} from '@tabler/icons-svelte-runes';
	import { signedInUserOf } from '#lib/domain/machines/machine.ts';
	import type { PageProps } from './$types';

	/**
	 * PROTOTYPE: the frame around the remote screen. The real screen is an
	 * H.264 stream decoded with WebCodecs onto a canvas.
	 */
	let { data }: PageProps = $props();

	const machine = $derived(data.machine);
	const user = $derived(signedInUserOf(machine));

	let display = $state(0);
	let inputMode = $state<'trackpad' | 'touch'>('trackpad');

	const displays = $derived(
		Array.from(
			{
				length: Math.max(1, machine.inventory.kind === 'known' ? machine.inventory.displayCount : 1)
			},
			(_, index) => ({
				index,
				label: `Display ${index + 1}`
			})
		)
	);
</script>

{#if machine.status.kind === 'offline'}
	<div class="notice">
		<IconPlugConnected size={32} />
		<p>This machine is offline. The desktop opens when it checks in again.</p>
	</div>
{:else if machine.inventory.kind === 'known' && machine.inventory.displayCount === 0 && machine.osFamily === 'windows'}
	<div class="notice">
		<IconDeviceDesktop size={32} />
		<p>This machine has no display. Use the terminal instead.</p>
	</div>
{:else}
	<div class="bar">
		<div class="group" role="group" aria-label="Display">
			{#each displays as item (item.index)}
				<button
					data-raw-button="chip"
					type="button"
					class="chip"
					aria-pressed={display === item.index}
					onclick={() => (display = item.index)}>{item.label}</button
				>
			{/each}
		</div>
		<div class="group">
			<button
				data-raw-button="icon"
				type="button"
				class="icon-button"
				aria-label="Input: {inputMode}"
				onclick={() => (inputMode = inputMode === 'trackpad' ? 'touch' : 'trackpad')}
			>
				{#if inputMode === 'trackpad'}
					<IconPointer size={20} />
				{:else}
					<IconHandFinger size={20} />
				{/if}
			</button>
			<button data-raw-button="icon" type="button" class="icon-button" aria-label="Keyboard"
				><IconKeyboard size={20} /></button
			>
			<button data-raw-button="icon" type="button" class="icon-button" aria-label="Full screen"
				><IconArrowsMaximize size={20} /></button
			>
		</div>
	</div>

	<div class="screen">
		<div class="placeholder">
			<IconDeviceDesktop size={48} stroke={1.25} />
			<p>{machine.name} · Display {display + 1}</p>
			<p class="hint">
				{user.kind === 'user'
					? `Connects straight away. ${user.name} sees a notice while you are connected.`
					: 'Nobody is signed in. The session starts at the sign-in screen.'}
			</p>
		</div>
	</div>

	<p class="mode">
		{inputMode === 'trackpad'
			? 'Trackpad mode: drag to move the pointer, tap to click, two fingers to scroll.'
			: 'Touch mode: tap where you want to click.'}
	</p>
{/if}

<style>
	.notice {
		display: grid;
		justify-items: center;
		gap: var(--space-3);
		padding: var(--space-12) var(--space-4);
		color: var(--muted);
		text-align: center;
	}

	.bar {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-3);
		margin-bottom: var(--space-3);
	}

	.group {
		display: flex;
		gap: var(--space-2);
	}

	.chip {
		padding: var(--space-1) var(--space-3);
		border: 1px solid var(--border);
		border-radius: var(--radius-pill);
		background: var(--surface-elevated);
		color: var(--text-soft);
		font-size: var(--text-sm);
		cursor: pointer;
	}

	.chip[aria-pressed='true'] {
		border-color: var(--brand);
		background: var(--brand-tint);
		color: var(--brand);
	}

	.icon-button {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 40px;
		height: 40px;
		border: 1px solid var(--border);
		border-radius: var(--radius-pill);
		background: var(--surface-elevated);
		color: var(--text-soft);
		cursor: pointer;
	}

	.screen {
		display: grid;
		place-items: center;
		aspect-ratio: 16 / 9;
		border-radius: var(--radius-card);
		background: var(--screen-bg);
		color: var(--terminal-text);
		overflow: hidden;
	}

	.placeholder {
		display: grid;
		justify-items: center;
		gap: var(--space-2);
		padding: var(--space-4);
		text-align: center;
		font-size: var(--text-sm);
	}

	.hint {
		color: var(--offline);
		font-size: var(--text-xs);
	}

	.mode {
		margin-top: var(--space-3);
		color: var(--muted);
		font-size: var(--text-xs);
	}
</style>

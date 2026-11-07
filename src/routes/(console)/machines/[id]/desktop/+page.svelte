<script lang="ts">
	import { hasPermission } from '#lib/domain/access/access.ts';
	import NoPermission from '../no-permission.svelte';
	import {
		IconArrowsMaximize,
		IconDeviceDesktop,
		IconKeyboard,
		IconPlugConnected,
		IconPointer,
		IconHandFinger
	} from '@tabler/icons-svelte-runes';
	import { signedInUserOf } from '#lib/domain/machines/machine.ts';
	import ChipGroup from '#lib/ui/chip-group.svelte';
	import EmptyState from '#lib/ui/empty-state.svelte';
	import type { PageProps } from './$types';

	/**
	 * PROTOTYPE: the frame around the remote screen. The real screen is an
	 * H.264 stream decoded with WebCodecs onto a canvas.
	 */
	let { data }: PageProps = $props();

	const machine = $derived(data.machine);
	const user = $derived(signedInUserOf(machine));

	let display = $state<string | null>('0');
	let inputMode = $state<'trackpad' | 'touch'>('trackpad');

	const displays = $derived(
		Array.from(
			{
				length: Math.max(1, machine.inventory.kind === 'known' ? machine.inventory.displayCount : 1)
			},
			(_, index) => ({
				value: String(index),
				label: `Display ${index + 1}`,
				count: undefined
			})
		)
	);
</script>

{#if !hasPermission(data.grants, 'desktop-view')}
	<NoPermission />
{:else if machine.status.kind === 'offline'}
	<EmptyState
		icon={IconPlugConnected}
		title="This machine is offline."
		detail="The desktop opens when it checks in again."
		children={undefined}
	/>
{:else if machine.inventory.kind === 'known' && machine.inventory.displayCount === 0 && machine.osFamily === 'windows'}
	<EmptyState
		icon={IconDeviceDesktop}
		title="This machine has no display."
		detail="Use the terminal instead."
		children={undefined}
	/>
{:else}
	<div class="session">
		<div class="bar">
			<ChipGroup label="Display" options={displays} bind:value={display} />
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
				<p>{machine.name} · Display {Number(display ?? '0') + 1}</p>
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
	</div>
{/if}

<style>
	.session {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: var(--space-3);
	}

	.bar {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-3);
	}

	.group {
		display: flex;
		gap: var(--space-2);
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
		color: var(--muted);
		font-size: var(--text-xs);
	}
</style>

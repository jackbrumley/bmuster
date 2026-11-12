<script lang="ts">
	import {
		IconArrowsMinimize,
		IconDeviceDesktop,
		IconEye,
		IconPlugConnectedX,
		IconX
	} from '@tabler/icons-svelte-runes';
	import type { DesktopMode } from '#lib/domain/sessions/session.ts';
	import Button from '#lib/ui/button.svelte';
	import type { TouchMode } from './touch-gestures.ts';
	import TouchInputChoice from './touch-input-choice.svelte';

	/**
	 * The Session tab of the full-screen sheet (SPEC-DESKTOP-FLOATING): the
	 * session's mode, the touch input choice in a control session, and the
	 * actions that end the sheet's use. The sheet closes itself before each.
	 */
	let {
		mode,
		canSwitch,
		touchMode,
		exit,
		ontouchmode,
		onswitch,
		onexit,
		ondisconnect
	}: {
		/** Undefined while no session runs: then only the exit action shows. */
		mode: DesktopMode | undefined;
		canSwitch: boolean;
		touchMode: TouchMode;
		exit: 'full-screen' | 'window';
		ontouchmode: (mode: TouchMode) => void;
		onswitch: (mode: DesktopMode) => void;
		onexit: () => void;
		ondisconnect: () => void;
	} = $props();

	const control = $derived(mode === 'control');
</script>

{#if mode !== undefined}
	<span class="mode">
		{#if control}
			<IconDeviceDesktop size={16} /> Control
		{:else}
			<IconEye size={16} /> View only
		{/if}
	</span>
{/if}
{#if control}
	<TouchInputChoice value={touchMode} onchange={ontouchmode} />
{/if}
<div class="actions">
	{#if mode !== undefined && canSwitch}
		<Button
			variant="secondary"
			size="compact"
			type="button"
			onclick={() => {
				onswitch(control ? 'watch' : 'control');
			}}>{control ? 'Switch to view only' : 'Take control'}</Button
		>
	{/if}
	<Button variant="secondary" size="compact" type="button" onclick={onexit}
		>{#if exit === 'window'}<IconX size={18} /> Close window{:else}<IconArrowsMinimize size={18} /> Leave
			full screen{/if}</Button
	>
	{#if mode !== undefined}
		<Button variant="secondary" size="compact" type="button" onclick={ondisconnect}
			><IconPlugConnectedX size={18} /> Disconnect</Button
		>
	{/if}
</div>

<style>
	.mode {
		display: inline-flex;
		align-items: center;
		gap: var(--space-1);
		justify-self: start;
		padding: var(--space-1) var(--space-3);
		border-radius: var(--radius-pill);
		background: var(--surface-muted);
		color: var(--text-soft);
		font-size: var(--text-xs);
		font-weight: var(--weight-medium);
	}

	.actions {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-2);
	}
</style>

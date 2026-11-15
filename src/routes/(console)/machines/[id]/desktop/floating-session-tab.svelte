<script lang="ts">
	import {
		IconArrowsMinimize,
		IconArrowsTransferUpDown,
		IconDeviceDesktop,
		IconEye,
		IconPlugConnectedX,
		IconDownload,
		IconUpload,
		IconX
	} from '@tabler/icons-svelte-runes';
	import type { DesktopMode } from '#lib/domain/sessions/session.ts';
	import Button from '#lib/ui/button.svelte';
	import type { SheetFiles, SheetTransfers } from './desktop-files.svelte.ts';
	import type { TouchMode } from './touch-gestures.ts';
	import TouchInputChoice from './touch-input-choice.svelte';
	import TransfersPanel from './transfers-panel.svelte';

	/**
	 * The Session tab of the full-screen sheet (SPEC-DESKTOP-FLOATING): the
	 * session's mode and status, the touch input choice in a control
	 * session, the files actions with the Transfers panel, and the actions
	 * that end the sheet's use. The sheet closes itself before those.
	 */
	let {
		status,
		transfers,
		mode,
		canSwitch,
		touchMode,
		exit,
		ontouchmode,
		onswitch,
		onexit,
		ondisconnect,
		files
	}: {
		status: string;
		/** The Transfers panel; undefined without files. */
		transfers: SheetTransfers | undefined;
		/** Undefined while no session runs: then only the exit action shows. */
		mode: DesktopMode | undefined;
		canSwitch: boolean;
		touchMode: TouchMode;
		exit: 'full-screen' | 'window';
		ontouchmode: (mode: TouchMode) => void;
		onswitch: (mode: DesktopMode) => void;
		onexit: () => void;
		ondisconnect: () => void;
		/** Upload files and Download N files (SPEC-SESSION-FILES), when sending is allowed. */
		files: SheetFiles | undefined;
	} = $props();

	const control = $derived(mode === 'control');
</script>

<div class="state">
	{#if mode !== undefined}
		<span class="mode">
			{#if control}
				<IconDeviceDesktop size={16} /> Control
			{:else}
				<IconEye size={16} /> View only
			{/if}
		</span>
	{/if}
	<span class="status" role="status">{status}</span>
</div>
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
	{#if files !== undefined}
		<Button variant="secondary" size="compact" type="button" onclick={files.upload}
			><IconUpload size={18} /> Upload files</Button
		>
		{#if files.download !== undefined}
			<Button variant="secondary" size="compact" type="button" onclick={files.download.run}
				><IconDownload size={18} /> {files.download.label}</Button
			>
		{/if}
	{/if}
	{#if transfers !== undefined}
		<Button variant="secondary" size="compact" type="button" onclick={transfers.toggle}
			><IconArrowsTransferUpDown size={18} />
			{transfers.running > 0 ? `Transfers (${transfers.running} running)` : 'Transfers'}</Button
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
{#if transfers?.open === true}
	<TransfersPanel sender={transfers.sender} />
{/if}

<style>
	.state {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-2);
	}

	.status {
		color: var(--muted);
		font-size: var(--text-xs);
		font-variant-numeric: tabular-nums;
	}

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

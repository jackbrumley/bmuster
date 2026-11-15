<script lang="ts">
	import type { Snippet } from 'svelte';
	import {
		IconAdjustmentsHorizontal,
		IconArrowsTransferUpDown,
		IconClipboard,
		IconDownload,
		IconEye,
		IconKeyboard,
		IconPlugConnectedX,
		IconPointer,
		IconUpload
	} from '@tabler/icons-svelte-runes';
	import { screenLabel } from '#lib/domain/desktop/screen.ts';
	import Button from '#lib/ui/button.svelte';
	import type { SessionChrome } from './session-chrome.svelte.ts';
	import ToolButton from './tool-button.svelte';

	/**
	 * The session's tools, the same on the tab's bar and on the floating bar
	 * of full screen and the pop-out (SPEC-DESKTOP 23): status, mode, Keys,
	 * Clipboard, Upload files, Download, Transfers, Picture settings, the
	 * frame's own tools (Full screen, Pop out) and Disconnect. Each shows
	 * while `chrome.actions` offers it. The floating bar draws them smaller
	 * and gives the keyboard back to the screen after each (`after`).
	 */
	let {
		chrome,
		look,
		after,
		frame
	}: {
		chrome: SessionChrome;
		look: 'bar' | 'overlay';
		/** Runs after each action. */
		after: () => void;
		/** The frame's own tools, before Disconnect. */
		frame: Snippet | undefined;
	} = $props();

	function act(action: () => void): () => void {
		return () => {
			action();
			after();
		};
	}

	const screen = $derived(chrome.running ? chrome.session?.screen : undefined);
	const watchOnly = $derived(chrome.watchOnly);
</script>

{#if look === 'overlay' && chrome.mode !== undefined}
	<span class="mode">{chrome.mode === 'control' ? 'Control' : 'View only'}</span>
{:else if watchOnly && chrome.running}
	<span class="badge"><IconEye size={16} /> View only</span>
{/if}
{#if look === 'bar' && screen !== undefined}
	<span class="screen-state" data-screen={screen.kind}>{screenLabel(screen)}</span>
{/if}
<span
	class="status"
	role="status"
	data-fps={chrome.session?.throughput.fps ?? 0}
	data-bytes-per-second={chrome.session?.throughput.bytesPerSecond ?? 0}>{chrome.status}</span
>
{#if chrome.has('mode')}
	{#if look === 'bar'}
		<Button
			variant="secondary"
			size="compact"
			type="button"
			onclick={act(() => {
				chrome.switchMode(watchOnly ? 'control' : 'watch');
			})}>{watchOnly ? 'Take control' : 'Switch to view only'}</Button
		>
	{:else}
		<ToolButton
			label={watchOnly ? 'Take control (reconnects)' : 'Switch to view only (reconnects)'}
			pressed={undefined}
			disabled={false}
			onclick={act(() => {
				chrome.switchMode(watchOnly ? 'control' : 'watch');
			})}
		>
			{#if watchOnly}<IconPointer size={20} />{:else}<IconEye size={20} />{/if}
		</ToolButton>
	{/if}
{/if}
{#if chrome.has('keys')}
	<ToolButton
		label="Keys"
		pressed={chrome.panel === 'keys'}
		disabled={false}
		onclick={act(() => {
			chrome.toggle('keys');
		})}
	>
		<IconKeyboard size={20} />
	</ToolButton>
{/if}
{#if chrome.has('clipboard')}
	<ToolButton
		label="Clipboard"
		pressed={chrome.panel === 'clipboard'}
		disabled={false}
		onclick={act(() => {
			chrome.toggle('clipboard');
		})}
	>
		<IconClipboard size={20} />
	</ToolButton>
{/if}
{#if chrome.has('upload')}
	<ToolButton
		label="Upload files"
		pressed={undefined}
		disabled={false}
		onclick={act(() => {
			chrome.upload();
		})}
	>
		<IconUpload size={20} />
	</ToolButton>
{/if}
{#if chrome.has('download') && chrome.download !== undefined}
	<Button variant="secondary" size="compact" type="button" onclick={act(chrome.download.run)}
		><IconDownload size={18} /> {chrome.download.label}</Button
	>
{/if}
{#if chrome.has('transfers')}
	<ToolButton
		label={chrome.transfersRunning > 0
			? `Transfers (${chrome.transfersRunning} running)`
			: 'Transfers'}
		pressed={chrome.transfersOpen}
		disabled={false}
		onclick={act(() => {
			chrome.toggleTransfers();
		})}
	>
		<IconArrowsTransferUpDown size={20} />
		{#if chrome.transfersRunning > 0}
			<span class="count" aria-hidden="true">{chrome.transfersRunning}</span>
		{/if}
	</ToolButton>
{/if}
{#if chrome.has('settings')}
	<ToolButton
		label="Picture settings"
		pressed={chrome.panel === 'settings'}
		disabled={false}
		onclick={act(() => {
			chrome.toggle('settings');
		})}
	>
		<IconAdjustmentsHorizontal size={20} />
	</ToolButton>
{/if}
{@render frame?.()}
{#if chrome.has('disconnect')}
	{#if look === 'bar'}
		<Button
			variant="secondary"
			size="compact"
			type="button"
			onclick={() => void chrome.disconnect()}>Disconnect</Button
		>
	{:else}
		<ToolButton
			label="Disconnect"
			pressed={undefined}
			disabled={false}
			onclick={() => void chrome.disconnect()}
		>
			<IconPlugConnectedX size={20} />
		</ToolButton>
	{/if}
{/if}

<style>
	.badge {
		display: inline-flex;
		align-items: center;
		gap: var(--space-1);
		padding: var(--space-1) var(--space-3);
		border-radius: var(--radius-pill);
		background: var(--surface-muted);
		color: var(--text-soft);
		font-size: var(--text-xs);
		font-weight: var(--weight-medium);
	}

	.mode {
		padding: 0 var(--space-2);
		color: var(--text-soft);
		font-size: var(--text-xs);
		font-weight: var(--weight-medium);
		white-space: nowrap;
	}

	.status {
		color: var(--muted);
		font-size: var(--text-xs);
		font-variant-numeric: tabular-nums;
		white-space: nowrap;
	}

	.count {
		min-width: 16px;
		padding: 0 var(--space-1);
		border-radius: var(--radius-pill);
		background: var(--brand);
		color: var(--brand-contrast);
		font-size: var(--text-xs);
		line-height: 16px;
	}

	.screen-state {
		color: var(--text-soft);
		font-size: var(--text-xs);
		font-weight: var(--weight-medium);
	}
</style>

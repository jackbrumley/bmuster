<script lang="ts">
	import {
		IconAdjustmentsHorizontal,
		IconArrowsMaximize,
		IconArrowsMinimize,
		IconClipboard,
		IconEye,
		IconKeyboard,
		IconWindowMaximize
	} from '@tabler/icons-svelte-runes';
	import type { DisplayChoice } from '#lib/domain/desktop/displays.ts';
	import { screenLabel, type DesktopScreen } from '#lib/domain/desktop/screen.ts';
	import type { DesktopMode } from '#lib/domain/sessions/session.ts';
	import type { Connection } from '#lib/runes/session-link.svelte.ts';
	import Button from '#lib/ui/button.svelte';
	import ChipGroup from '#lib/ui/chip-group.svelte';
	import type { Throughput } from './desktop-session.svelte.ts';
	import ToolButton from './tool-button.svelte';

	/**
	 * The desktop tab's bar above the screen (SPEC-DESKTOP): the screen
	 * picker, what the machine's screen shows, the session's status, and the
	 * tools. A phone keeps it hidden and uses the phone toolbar instead.
	 */
	let {
		hidden,
		connection,
		throughput,
		mode,
		running,
		canControl,
		choosing,
		fullScreen,
		screen,
		displays,
		display,
		keysOpen,
		clipboardOpen,
		settingsOpen,
		ondisplay,
		onswitch,
		onkeys,
		onclipboard,
		onsettings,
		onfullscreen,
		onpopout,
		ondisconnect
	}: {
		hidden: boolean;
		connection: Connection;
		/** Undefined before the session exists. */
		throughput: Throughput | undefined;
		mode: DesktopMode | undefined;
		running: boolean;
		canControl: boolean;
		/** No session runs: Connect and Watch only show instead of the screen. */
		choosing: boolean;
		fullScreen: boolean;
		/** What the machine's screen shows, while a session runs. */
		screen: DesktopScreen | undefined;
		displays: readonly DisplayChoice[];
		display: string | null;
		keysOpen: boolean;
		clipboardOpen: boolean;
		settingsOpen: boolean;
		ondisplay: (id: string) => void;
		onswitch: (mode: DesktopMode) => void;
		onkeys: () => void;
		onclipboard: () => void;
		onsettings: () => void;
		onfullscreen: () => void;
		onpopout: () => void;
		ondisconnect: () => void;
	} = $props();

	const watchOnly = $derived(mode === 'watch');

	const status = $derived.by(() => {
		switch (connection.kind) {
			case 'idle':
				return 'Not connected';
			case 'starting':
			case 'connecting':
				return 'Connecting…';
			case 'live': {
				if (!connection.ready) {
					return 'Waiting for the machine…';
				}
				const { fps, bytesPerSecond } = throughput ?? { fps: 0, bytesPerSecond: 0 };
				return `${fps} fps · ${Math.round(bytesPerSecond / 1024)} KB/s`;
			}
			case 'reconnecting':
				return 'Reconnecting…';
			case 'moved':
				return 'Open in another window';
			case 'ended':
				return 'Ended';
		}
	});
</script>

<div class="bar" class:hidden>
	{#if displays.length > 1}
		<ChipGroup
			label="Display"
			options={displays}
			bind:value={
				() => display,
				(value: string | null) => {
					if (value !== null) ondisplay(value);
				}
			}
		/>
	{/if}
	<div class="tools">
		{#if watchOnly && running}
			<span class="badge"><IconEye size={16} /> View only</span>
		{/if}
		{#if screen !== undefined}
			<span class="screen-state" data-screen={screen.kind}>{screenLabel(screen)}</span>
		{/if}
		<span
			class="status"
			role="status"
			data-fps={throughput?.fps ?? 0}
			data-bytes-per-second={throughput?.bytesPerSecond ?? 0}>{status}</span
		>
		{#if running && canControl && mode !== undefined}
			<Button
				variant="secondary"
				size="compact"
				type="button"
				onclick={() => {
					onswitch(watchOnly ? 'control' : 'watch');
				}}>{watchOnly ? 'Take control' : 'Switch to view only'}</Button
			>
		{/if}
		{#if running && !watchOnly}
			<ToolButton label="Keys" pressed={keysOpen} disabled={false} onclick={onkeys}>
				<IconKeyboard size={20} />
			</ToolButton>
		{/if}
		{#if running && !watchOnly}
			<ToolButton label="Clipboard" pressed={clipboardOpen} disabled={false} onclick={onclipboard}>
				<IconClipboard size={20} />
			</ToolButton>
		{/if}
		{#if running}
			<ToolButton
				label="Picture settings"
				pressed={settingsOpen}
				disabled={false}
				onclick={onsettings}
			>
				<IconAdjustmentsHorizontal size={20} />
			</ToolButton>
		{/if}
		{#if !choosing}
			<ToolButton
				label={fullScreen ? 'Leave full screen' : 'Full screen'}
				pressed={undefined}
				disabled={false}
				onclick={onfullscreen}
			>
				{#if fullScreen}
					<IconArrowsMinimize size={20} />
				{:else}
					<IconArrowsMaximize size={20} />
				{/if}
			</ToolButton>
		{/if}
		{#if running}
			<ToolButton
				label="Pop out into a window"
				pressed={undefined}
				disabled={false}
				onclick={onpopout}
			>
				<IconWindowMaximize size={20} />
			</ToolButton>
		{/if}
		{#if running}
			<Button variant="secondary" size="compact" type="button" onclick={ondisconnect}
				>Disconnect</Button
			>
		{/if}
	</div>
</div>

<style>
	.bar {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-2) var(--space-3);
	}

	.bar.hidden {
		display: none;
	}

	.tools {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: flex-end;
		gap: var(--space-2);
		margin-left: auto;
	}

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

	.status {
		color: var(--muted);
		font-size: var(--text-xs);
		font-variant-numeric: tabular-nums;
		white-space: nowrap;
	}

	.screen-state {
		color: var(--text-soft);
		font-size: var(--text-xs);
		font-weight: var(--weight-medium);
	}
</style>

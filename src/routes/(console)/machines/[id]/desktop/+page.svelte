<script lang="ts">
	import { onMount } from 'svelte';
	import {
		IconAdjustmentsHorizontal,
		IconArrowsMaximize,
		IconArrowsMinimize,
		IconDeviceDesktop,
		IconEye,
		IconHandFinger,
		IconPlugConnected,
		IconPointer
	} from '@tabler/icons-svelte-runes';
	import { hasPermission, type Permission } from '#lib/domain/access/access.ts';
	import type {
		DesktopSettings as PictureSettings,
		InputMessage
	} from '#lib/domain/desktop/messages.ts';
	import type { DesktopMode } from '#lib/domain/sessions/session.ts';
	import { signedInUserOf } from '#lib/domain/machines/machine.ts';
	import Button from '#lib/ui/button.svelte';
	import ChipGroup from '#lib/ui/chip-group.svelte';
	import { confirmAction } from '#lib/ui/confirm-action.svelte.ts';
	import EmptyState from '#lib/ui/empty-state.svelte';
	import Notice from '#lib/ui/notice.svelte';
	import Panel from '#lib/ui/panel.svelte';
	import NoPermission from '../no-permission.svelte';
	import { DesktopCanvas } from './desktop-canvas.ts';
	import { DesktopSession } from './desktop-session.svelte.ts';
	import DesktopSettings from './desktop-settings.svelte';
	import FullScreenBar from './full-screen-bar.svelte';
	import type { Geometry } from './input.ts';
	import { attachScreenInput } from './screen-input.ts';
	import KeyBar from './key-bar.svelte';
	import ToolButton from './tool-button.svelte';
	import type { PageProps } from './$types';

	/**
	 * The machine's screen (SPEC-DESKTOP): JPEG tiles drawn on a canvas, the
	 * cursor drawn locally, mouse, keyboard and touch sent back. The session
	 * runs on the server and the agent: a reload comes back to it. The person
	 * at the machine sees a notice bar while anyone is connected.
	 */
	let { data }: PageProps = $props();

	const machine = $derived(data.machine);
	const canWatch = $derived(hasPermission(data.grants, 'desktop-view'));
	const canControl = $derived(hasPermission(data.grants, 'desktop-control'));
	const user = $derived(signedInUserOf(machine));

	let stage = $state<HTMLElement>();
	let screenCanvas = $state<HTMLCanvasElement>();
	let cursorCanvas = $state<HTMLCanvasElement>();
	let session = $state<DesktopSession>();
	let touchMode = $state<'trackpad' | 'touch'>('trackpad');
	let showSettings = $state(false);
	let fullScreen = $state(false);

	const connection = $derived(session?.connection ?? { kind: 'idle' as const });
	const running = $derived(
		connection.kind === 'live' ||
			connection.kind === 'connecting' ||
			connection.kind === 'starting' ||
			connection.kind === 'reconnecting'
	);
	const watchOnly = $derived(session?.mode === 'watch');
	/**
	 * Connect and Watch only are offered whenever no session runs: at first,
	 * after Disconnect and after the session ended. A reload or a dropped
	 * connection reattaches instead (`connecting`), keeping the mode.
	 */
	const choosing = $derived(connection.kind === 'idle' || connection.kind === 'ended');
	const frame = $derived(session?.frameSize);
	const display = $derived(session?.displays.find((item) => item.id === session?.current));
	const displayOptions = $derived(
		(session?.displays ?? []).map((item) => ({
			value: item.id,
			label: item.name,
			count: undefined
		}))
	);

	/** True when the person's rules for this mode ask the person at the screen first. */
	function asksFirst(mode: DesktopMode): boolean {
		const needed: Permission = mode === 'control' ? 'desktop-control' : 'desktop-view';
		return data.grants.some((grant) => grant.permission === needed && grant.consent === 'ask');
	}

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
				const { fps, bytesPerSecond } = session?.throughput ?? { fps: 0, bytesPerSecond: 0 };
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

	function geometry(): Geometry | undefined {
		if (screenCanvas === undefined || display === undefined || frame === undefined) {
			return undefined;
		}
		const rect = screenCanvas.getBoundingClientRect();
		return {
			box: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
			picture: frame,
			display: { width: display.width, height: display.height }
		};
	}

	function viewport(): { width: number; height: number; pixelRatio: number } {
		const rect = stage?.getBoundingClientRect();
		return {
			width: Math.round(rect?.width ?? window.innerWidth),
			height: Math.round(fullScreen ? (rect?.height ?? window.innerHeight) : window.innerHeight),
			pixelRatio: window.devicePixelRatio
		};
	}

	function start(mode: DesktopMode): void {
		showSettings = false;
		void session?.start(mode);
	}

	function switchMode(mode: DesktopMode): void {
		showSettings = false;
		void session?.switchMode(mode);
	}

	async function endSession(): Promise<void> {
		const yes = await confirmAction({
			title: 'Disconnect from this screen?',
			message: 'The session ends, and the notice on the machine goes away.',
			confirmLabel: 'Disconnect'
		});
		if (yes) {
			session?.end();
		}
	}

	async function toggleFullScreen(): Promise<void> {
		if (document.fullscreenElement !== null) {
			await document.exitFullscreen();
		} else {
			await stage?.requestFullscreen();
		}
	}

	$effect(() => {
		// A session that ends in full screen leaves it, so the choices show.
		if (fullScreen && !running && document.fullscreenElement !== null) {
			void document.exitFullscreen();
		}
	});

	onMount(() => {
		const surface = stage;
		if (
			!canWatch ||
			machine.status.kind === 'offline' ||
			surface === undefined ||
			screenCanvas === undefined ||
			cursorCanvas === undefined
		) {
			return;
		}
		const current = new DesktopSession(
			machine.id,
			new DesktopCanvas(screenCanvas, cursorCanvas),
			viewport
		);
		session = current;
		void current.resume();

		const onFullScreen = () => {
			fullScreen = document.fullscreenElement !== null;
			requestAnimationFrame(() => {
				current.viewportChanged();
			});
		};
		const detachInput = attachScreenInput(surface, {
			send: (message) => {
				current.input(message);
			},
			controlling: () => current.controlling,
			geometry,
			touchMode: () => touchMode
		});
		document.addEventListener('fullscreenchange', onFullScreen);
		return () => {
			detachInput();
			document.removeEventListener('fullscreenchange', onFullScreen);
			current.detach();
		};
	});
</script>

{#if !canWatch}
	<NoPermission />
{:else if machine.status.kind === 'offline'}
	<EmptyState
		icon={IconPlugConnected}
		title="This machine is offline."
		detail="The desktop opens when it checks in again."
		children={undefined}
	/>
{:else}
	<div class="session">
		<div class="bar">
			{#if displayOptions.length > 1}
				<ChipGroup
					label="Display"
					options={displayOptions}
					bind:value={
						() => session?.current ?? null,
						(value: string | null) => {
							if (value !== null) session?.selectDisplay(value);
						}
					}
				/>
			{/if}
			<div class="tools">
				{#if watchOnly && running}
					<span class="badge"><IconEye size={16} /> View only</span>
				{/if}
				<span
					class="status"
					role="status"
					data-fps={session?.throughput.fps ?? 0}
					data-bytes-per-second={session?.throughput.bytesPerSecond ?? 0}>{status}</span
				>
				{#if running && canControl && session?.mode !== undefined}
					<Button
						variant="secondary"
						size="compact"
						type="button"
						onclick={() => {
							switchMode(watchOnly ? 'control' : 'watch');
						}}>{watchOnly ? 'Take control' : 'Switch to view only'}</Button
					>
				{/if}
				{#if running && !watchOnly}
					<ToolButton
						label={touchMode === 'trackpad'
							? 'Touch input: trackpad. Switch to tapping where to click'
							: 'Touch input: tap where to click. Switch to trackpad'}
						pressed={undefined}
						disabled={false}
						onclick={() => (touchMode = touchMode === 'trackpad' ? 'touch' : 'trackpad')}
					>
						{#if touchMode === 'trackpad'}
							<IconPointer size={20} />
						{:else}
							<IconHandFinger size={20} />
						{/if}
					</ToolButton>
				{/if}
				{#if running}
					<ToolButton
						label="Picture settings"
						pressed={showSettings}
						disabled={false}
						onclick={() => (showSettings = !showSettings)}
					>
						<IconAdjustmentsHorizontal size={20} />
					</ToolButton>
				{/if}
				{#if !choosing}
					<ToolButton
						label={fullScreen ? 'Leave full screen' : 'Full screen'}
						pressed={undefined}
						disabled={false}
						onclick={() => void toggleFullScreen()}
					>
						{#if fullScreen}
							<IconArrowsMinimize size={20} />
						{:else}
							<IconArrowsMaximize size={20} />
						{/if}
					</ToolButton>
				{/if}
				{#if running}
					<Button variant="secondary" size="compact" type="button" onclick={() => void endSession()}
						>Disconnect</Button
					>
				{/if}
			</div>
		</div>

		{#if connection.kind === 'ended'}
			<Notice tone="info" title={connection.message} children={undefined} />
		{:else if connection.kind === 'moved'}
			<Notice tone="info" title="This session is open in another window or tab.">
				<div class="actions">
					<Button
						variant="primary"
						size="compact"
						type="button"
						onclick={() => void session?.takeBack()}>Use it here</Button
					>
				</div>
			</Notice>
		{/if}

		{#if session?.problem !== undefined && running}
			<Notice tone="warning" title={session.problem} children={undefined} />
		{/if}

		{#if session?.stalled === true && running}
			<Notice tone="warning" title="The picture is paused: frames were not getting through.">
				<div class="actions">
					<Button
						variant="secondary"
						size="compact"
						type="button"
						onclick={() => session?.requestKeyframe()}>Resume</Button
					>
				</div>
			</Notice>
		{/if}

		{#if choosing}
			<Panel heading={undefined} actions={undefined} tone="normal" padding="normal">
				<div class="start">
					<IconDeviceDesktop size={40} stroke={1.25} />
					<p>
						{user.kind === 'user'
							? `${user.name} sees a notice while you are connected, and can disconnect you.`
							: 'Nobody is signed in. You see the sign-in screen.'}
					</p>
					{#if asksFirst(canControl ? 'control' : 'watch')}
						<p class="hint">
							Your access to this machine asks the person at the screen first. BMuster cannot ask
							yet, so ask an admin to make the rule connect without asking.
						</p>
					{:else}
						<div class="actions">
							{#if canControl}
								<Button
									variant="primary"
									size="compact"
									type="button"
									onclick={() => {
										start('control');
									}}>Connect</Button
								>
							{/if}
							<Button
								variant={canControl ? 'secondary' : 'primary'}
								size="compact"
								type="button"
								onclick={() => {
									start('watch');
								}}>Watch only</Button
							>
						</div>
					{/if}
				</div>
			</Panel>
		{/if}

		{#if showSettings && session !== undefined && running && !fullScreen}
			<DesktopSettings
				settings={session.settings}
				onchange={(next: PictureSettings) => session?.changeSettings(next)}
			/>
		{/if}

		<div
			class="stage"
			class:full={fullScreen}
			class:hidden={choosing}
			class:watching={watchOnly}
			bind:this={stage}
			style:aspect-ratio={frame !== undefined ? `${frame.width} / ${frame.height}` : '16 / 9'}
			role="application"
			aria-label="Screen of {machine.name}"
		>
			<canvas class="screen" bind:this={screenCanvas} aria-hidden="true"></canvas>
			<canvas class="cursor" bind:this={cursorCanvas} aria-hidden="true"></canvas>
			{#if frame === undefined && running}
				<p class="waiting">{status}</p>
			{/if}
			{#if fullScreen && stage !== undefined}
				<FullScreenBar
					surface={stage}
					mode={running ? session?.mode : undefined}
					canSwitch={canControl}
					windows={machine.osFamily === 'windows'}
					settingsOpen={showSettings}
					onexit={() => void toggleFullScreen()}
					onswitch={switchMode}
					onsettings={() => (showSettings = !showSettings)}
					ondisconnect={() => void endSession()}
				>
					{#snippet settings()}
						{#if session !== undefined}
							<DesktopSettings
								settings={session.settings}
								onchange={(next: PictureSettings) => session?.changeSettings(next)}
							/>
						{/if}
					{/snippet}
				</FullScreenBar>
			{/if}
		</div>

		{#if running && !watchOnly}
			<div class="phone-keys">
				<KeyBar send={(message: InputMessage) => session?.input(message)} />
			</div>
			<p class="mode">
				{touchMode === 'trackpad'
					? 'Trackpad: drag to move the pointer, tap to click, two fingers to scroll or right-click.'
					: 'Touch: tap where you want to click, drag to drag.'}
			</p>
		{/if}
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
		gap: var(--space-2) var(--space-3);
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

	.actions {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-2);
		margin-top: var(--space-2);
	}

	.start {
		display: grid;
		justify-items: center;
		gap: var(--space-2);
		padding: var(--space-4) 0;
		color: var(--text-soft);
		text-align: center;
		font-size: var(--text-sm);
	}

	.start p {
		margin: 0;
		max-width: 46ch;
	}

	.hint {
		color: var(--muted);
	}

	.stage {
		position: relative;
		width: 100%;
		max-height: 78vh;
		margin: 0 auto;
		border-radius: var(--radius-card);
		background: var(--screen-bg);
		overflow: hidden;
	}

	.stage.hidden {
		display: none;
	}

	.stage.full {
		max-height: none;
		border-radius: 0;
	}

	.stage:not(.watching) {
		touch-action: none;
	}

	.stage:focus-visible {
		outline-offset: -2px;
	}

	.screen,
	.cursor {
		position: absolute;
		inset: 0;
		width: 100%;
		height: 100%;
		object-fit: contain;
		pointer-events: none;
	}

	.waiting {
		position: absolute;
		inset: 0;
		display: grid;
		place-items: center;
		margin: 0;
		color: var(--terminal-text);
		font-size: var(--text-sm);
		pointer-events: none;
	}

	.mode {
		margin: 0;
		color: var(--muted);
		font-size: var(--text-xs);
	}

	@media (min-width: 900px) {
		.phone-keys {
			display: none;
		}
	}
</style>

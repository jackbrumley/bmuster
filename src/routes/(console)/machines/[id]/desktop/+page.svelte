<script lang="ts">
	import { onMount } from 'svelte';
	import { MediaQuery } from 'svelte/reactivity';
	import {
		IconAdjustmentsHorizontal,
		IconArrowsMaximize,
		IconArrowsMinimize,
		IconCrosshair,
		IconEye,
		IconKeyboard
	} from '@tabler/icons-svelte-runes';
	import { hasPermission, type Permission } from '#lib/domain/access/access.ts';
	import type {
		DesktopSettings as PictureSettings,
		InputMessage
	} from '#lib/domain/desktop/messages.ts';
	import { displayChoices, shownSize } from '#lib/domain/desktop/displays.ts';
	import { screenLabel } from '#lib/domain/desktop/screen.ts';
	import type { DesktopMode } from '#lib/domain/sessions/session.ts';
	import { signedInUserOf } from '#lib/domain/machines/machine.ts';
	import Button from '#lib/ui/button.svelte';
	import ChipGroup from '#lib/ui/chip-group.svelte';
	import { confirmAction } from '#lib/ui/confirm-action.svelte.ts';
	import Notice from '#lib/ui/notice.svelte';
	import LoadingVeil from '#lib/ui/loading-veil.svelte';
	import { machinePresence } from '#lib/runes/machine-presence.svelte.ts';
	import MachineUnreachable from '../machine-unreachable.svelte';
	import NoPermission from '../no-permission.svelte';
	import { DesktopCanvas } from './desktop-canvas.ts';
	import { DesktopSession } from './desktop-session.svelte.ts';
	import DesktopSettings from './desktop-settings.svelte';
	import DesktopStart from './desktop-start.svelte';
	import FloatingControls from './floating-controls.svelte';
	import FullScreenBar from './full-screen-bar.svelte';
	import { FullScreen } from './full-screen.svelte.ts';
	import { dismissHint, hintDismissed } from './gesture-hint.ts';
	import GestureHint from './gesture-hint.svelte';
	import { attachScreenInput } from './screen-input.ts';
	import { watchViewport } from './viewport-watch.ts';
	import type { Geometry, TouchMode } from './touch-gestures.ts';
	import TouchInputChoice from './touch-input-choice.svelte';
	import { readTouchMode, saveTouchMode, touchModeHelp } from './touch-input.ts';
	import { NO_ZOOM, zoomTransform, type Zoom } from './zoom.ts';
	import KeyBar from './key-bar.svelte';
	import KeysMenu from './keys-menu.svelte';
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
	// The machine page's one live status (SPEC-PRESENCE P10); ./+layout.svelte remounts the tab when it changes.
	const presence = machinePresence();
	const presenceStatus = $derived(presence.status);
	const canWatch = $derived(hasPermission(data.grants, 'desktop-view'));
	const canControl = $derived(hasPermission(data.grants, 'desktop-control'));
	const user = $derived(signedInUserOf(machine));

	let stage = $state<HTMLElement>();
	let screenCanvas = $state<HTMLCanvasElement>();
	let cursorCanvas = $state<HTMLCanvasElement>();
	let session = $state<DesktopSession>();
	let touchMode = $state<TouchMode>('trackpad');
	/** The box the picture is drawn in, before any pinch zoom. */
	let picture = $state<HTMLElement>();
	/** The picture's pinch zoom, drawn here only (SPEC-DESKTOP-FLOATING, option A). */
	let zoom = $state<Zoom>(NO_ZOOM);
	/** This browser has put the touch gestures hint away; read on mount. */
	let hintGone = $state(true);
	/** The block under the bar: picture settings or the Keys menu, never both. */
	let open = $state<'none' | 'settings' | 'keys'>('none');
	/** The browser's full screen, or the stage filling the window where there is none. */
	const screenMode = new FullScreen(() => session?.viewportChanged());
	const fullScreen = $derived(screenMode.on);
	/**
	 * Phones and tablets get the movable controls button in full screen
	 * instead of the bar (SPEC-DESKTOP-FLOATING 1): a finger, or a window
	 * narrower than the sidebar breakpoint.
	 */
	const touchLayout = new MediaQuery('(pointer: coarse), (max-width: 899px)');
	/** A finger is the main pointer: the gestures hint is for this device. */
	const touchDevice = new MediaQuery('(pointer: coarse)');

	const connection = $derived(session?.connection ?? { kind: 'idle' as const });
	const running = $derived(
		connection.kind === 'live' ||
			connection.kind === 'connecting' ||
			connection.kind === 'starting' ||
			connection.kind === 'reconnecting'
	);
	const watchOnly = $derived(session?.mode === 'watch');
	/** Only a control session sends keys (SPEC-DESKTOP-KEYS 7). */
	const keysOpen = $derived(open === 'keys' && running && !watchOnly);
	/** The first control session on a touch device explains the gestures, once. */
	const showHint = $derived(touchDevice.current && running && !watchOnly && !hintGone);
	/**
	 * Connect and Watch only are offered whenever no session runs: at first,
	 * after Disconnect and after the session ended. A reload or a dropped
	 * connection reattaches instead (`connecting`), keeping the mode.
	 */
	const choosing = $derived(connection.kind === 'idle' || connection.kind === 'ended');
	const frame = $derived(session?.frameSize);
	/** What the machine's screen shows (sign-in screen, someone's desktop, nothing to show). */
	const screenState = $derived(running ? session?.screen : undefined);
	/** What the picture covers on the machine: one display, or the box around them all. */
	const display = $derived(shownSize(session?.displays ?? [], session?.current));
	/** The screen picker: each display, and All screens when the agent can (SPEC-DESKTOP-ALL-SCREENS). */
	const displayOptions = $derived(
		displayChoices(session?.displays ?? [], session?.allScreens ?? false)
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

	/** Until the first picture arrives the stage waits under the veil, saying what it waits for. */
	const connectingTitle = $derived.by(() => {
		if (frame !== undefined || !running) return undefined;
		switch (connection.kind) {
			case 'starting':
			case 'connecting':
				return `Connecting to ${machine.name}`;
			case 'reconnecting':
				return 'Reconnecting';
			case 'live':
				return connection.ready ? 'Waiting for the first picture' : 'Waiting for the machine';
			case 'idle':
			case 'moved':
			case 'ended':
				return undefined;
		}
	});

	function geometry(): Geometry | undefined {
		if (picture === undefined || display === undefined || frame === undefined) {
			return undefined;
		}
		// The unzoomed box: the zoom is drawn on the canvases inside it, and the input maps through it.
		const rect = picture.getBoundingClientRect();
		return {
			box: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
			picture: frame,
			display
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

	function toggle(block: 'settings' | 'keys'): void {
		open = open === block ? 'none' : block;
	}

	/** After a key from the Keys menu, typing goes to the machine again. */
	function backToScreen(): void {
		stage?.focus();
	}

	function sendInput(message: InputMessage): void {
		session?.input(message);
	}

	function start(mode: DesktopMode): void {
		open = 'none';
		void session?.start(mode);
	}

	function switchMode(mode: DesktopMode): void {
		open = 'none';
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
		if (stage !== undefined) {
			await screenMode.toggle(stage);
		}
	}

	$effect(() => {
		// A session that ends in full screen leaves it, so the choices show.
		if (fullScreen && !running) {
			void screenMode.leave();
		}
	});

	function chooseTouchMode(next: TouchMode): void {
		touchMode = next;
		saveTouchMode(next);
	}

	function putHintAway(): void {
		hintGone = true;
		dismissHint();
	}

	onMount(() => {
		hintGone = hintDismissed();
		touchMode = readTouchMode();
		const surface = stage;
		if (
			!canWatch ||
			presenceStatus.kind !== 'online' ||
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

		const detachInput = attachScreenInput(surface, {
			send: (message) => {
				current.input(message);
			},
			controlling: () => current.controlling,
			geometry,
			touchMode: () => touchMode,
			zoom: (next) => {
				zoom = next;
			}
		});
		const detachFullScreen = screenMode.attach();
		const detachViewport = watchViewport(surface, () => {
			current.viewportChanged();
		});
		return () => {
			detachInput();
			detachFullScreen();
			detachViewport();
			current.detach();
		};
	});
</script>

{#if !canWatch}
	<NoPermission />
{:else if presenceStatus.kind !== 'online'}
	<MachineUnreachable status={presenceStatus} detail="The desktop opens when it is back." />
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
				{#if screenState !== undefined}
					<span class="screen-state" data-screen={screenState.kind}>{screenLabel(screenState)}</span
					>
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
						label="Keys"
						pressed={keysOpen}
						disabled={false}
						onclick={() => {
							toggle('keys');
						}}
					>
						<IconKeyboard size={20} />
					</ToolButton>
				{/if}
				{#if running}
					<ToolButton
						label="Picture settings"
						pressed={open === 'settings'}
						disabled={false}
						onclick={() => {
							toggle('settings');
						}}
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
			<DesktopStart
				{user}
				{canControl}
				asksFirst={asksFirst(canControl ? 'control' : 'watch')}
				onstart={start}
			/>
		{/if}

		{#if open === 'settings' && session !== undefined && running && !fullScreen}
			<DesktopSettings
				settings={session.settings}
				autoLevel={session.autoLevel}
				agentVersion={machine.agentVersion}
				onchange={(next: PictureSettings) => session?.changeSettings(next)}
			/>
		{/if}

		{#if keysOpen && !fullScreen}
			<KeysMenu osFamily={machine.osFamily} send={sendInput} afterSend={backToScreen} />
		{/if}

		{#if showHint && !fullScreen}
			<GestureHint ondismiss={putHintAway} />
		{/if}

		<div
			class="stage"
			class:full={fullScreen}
			class:filling={screenMode.filling}
			class:hidden={choosing}
			class:watching={watchOnly}
			bind:this={stage}
			style:aspect-ratio={fullScreen
				? undefined
				: frame !== undefined
					? `${frame.width} / ${frame.height}`
					: '16 / 9'}
			role="application"
			aria-label="Screen of {machine.name}"
			aria-busy={connectingTitle !== undefined}
		>
			<div class="picture" bind:this={picture}>
				<canvas
					class="screen"
					bind:this={screenCanvas}
					style:transform={zoomTransform(zoom)}
					aria-hidden="true"
				></canvas>
				<canvas
					class="cursor"
					bind:this={cursorCanvas}
					style:transform={zoomTransform(zoom)}
					aria-hidden="true"
				></canvas>
				{#if touchMode === 'fixed' && running && !watchOnly}
					<!-- The fixed cursor's place, shown before the machine's own cursor gets there. -->
					<span class="centre-mark" aria-hidden="true"><IconCrosshair size={28} /></span>
				{/if}
			</div>
			{#if showHint && fullScreen}
				<div class="hint-over">
					<GestureHint ondismiss={putHintAway} />
				</div>
			{/if}
			{#if screenState?.kind === 'approval'}
				<div class="waiting">
					<p>{screenLabel(screenState)}</p>
					{#if screenState.phase !== 'pending'}
						<Button
							type="button"
							variant="primary"
							size="compact"
							onclick={() => session?.askApproval()}>Ask for approval</Button
						>
					{/if}
				</div>
			{:else if screenState?.kind === 'unavailable'}
				<p class="waiting unavailable">{screenLabel(screenState)}</p>
			{:else if connectingTitle !== undefined}
				<div class="connecting">
					<LoadingVeil
						active={true}
						title={connectingTitle}
						detail={undefined}
						children={undefined}
					/>
				</div>
			{/if}
			{#if fullScreen && touchLayout.current && session !== undefined}
				<FloatingControls
					osFamily={machine.osFamily}
					mode={running ? session.mode : undefined}
					canSwitch={canControl}
					{touchMode}
					displays={displayOptions}
					display={session.current ?? null}
					settings={session.settings}
					autoLevel={session.autoLevel}
					agentVersion={machine.agentVersion}
					send={sendInput}
					{backToScreen}
					ontouchmode={chooseTouchMode}
					ondisplay={(id: string) => session?.selectDisplay(id)}
					onsettings={(next: PictureSettings) => session?.changeSettings(next)}
					onswitch={switchMode}
					onexit={() => void toggleFullScreen()}
					ondisconnect={() => void endSession()}
				/>
			{:else if fullScreen && stage !== undefined}
				<FullScreenBar
					surface={stage}
					mode={running ? session?.mode : undefined}
					canSwitch={canControl}
					displays={displayOptions}
					display={session?.current ?? null}
					ondisplay={(id: string) => session?.selectDisplay(id)}
					settingsOpen={open === 'settings'}
					{keysOpen}
					onexit={() => void toggleFullScreen()}
					onswitch={switchMode}
					onsettings={() => {
						toggle('settings');
					}}
					onkeys={() => {
						toggle('keys');
					}}
					ondisconnect={() => void endSession()}
				>
					{#snippet settings()}
						{#if session !== undefined}
							<DesktopSettings
								settings={session.settings}
								autoLevel={session.autoLevel}
								agentVersion={machine.agentVersion}
								onchange={(next: PictureSettings) => session?.changeSettings(next)}
							/>
						{/if}
					{/snippet}
					{#snippet keys()}
						<KeysMenu osFamily={machine.osFamily} send={sendInput} afterSend={backToScreen} />
					{/snippet}
				</FullScreenBar>
			{/if}
		</div>

		{#if running && !watchOnly}
			<div class="phone-keys">
				<KeyBar osFamily={machine.osFamily} send={sendInput} onkeyboard={undefined} />
			</div>
			<div class="touch-input">
				<TouchInputChoice value={touchMode} onchange={chooseTouchMode} />
				<p class="mode">{touchModeHelp(touchMode)}</p>
			</div>
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

	.screen-state {
		color: var(--text-soft);
		font-size: var(--text-xs);
		font-weight: var(--weight-medium);
	}

	.actions {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-2);
		margin-top: var(--space-2);
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

	/* Over the console's own frame (z-index 10), under the toasts (30). */
	.stage.filling {
		position: fixed;
		top: 0;
		right: 0;
		bottom: 0;
		left: 0;
		z-index: 20;
		width: 100%;
		height: 100dvh;
	}

	/* The picture keeps clear of the notch and the home bar; the controls do too. */
	.stage.filling .picture {
		top: var(--safe-top);
		right: var(--safe-right);
		bottom: var(--safe-bottom);
		left: var(--safe-left);
	}

	.stage:not(.watching) {
		touch-action: none;
	}

	.stage:focus-visible {
		outline-offset: -2px;
	}

	/* Where the picture is drawn at 1x; a pinch zoom scales the canvases from its top-left corner. */
	.picture {
		position: absolute;
		inset: 0;
		pointer-events: none;
	}

	.screen,
	.cursor {
		position: absolute;
		inset: 0;
		width: 100%;
		height: 100%;
		object-fit: contain;
		transform-origin: 0 0;
		pointer-events: none;
	}

	.centre-mark {
		position: absolute;
		top: 50%;
		left: 50%;
		display: grid;
		color: var(--brand);
		opacity: 0.8;
		transform: translate(-50%, -50%);
	}

	.touch-input {
		display: grid;
		gap: var(--space-2);
	}

	/* Over the screen in full screen, under the controls button (z-index 2). */
	.hint-over {
		position: absolute;
		top: calc(var(--space-3) + var(--safe-top));
		left: 50%;
		z-index: 1;
		width: min(340px, calc(100% - var(--space-12) - var(--space-12)));
		transform: translateX(-50%);
	}

	.waiting {
		position: absolute;
		inset: 0;
		display: grid;
		place-items: center;
		margin: 0;
		color: var(--terminal-text);
		font-size: var(--text-sm);
	}

	.connecting {
		position: absolute;
		inset: 0;
		display: grid;
	}

	.waiting.unavailable {
		padding: var(--space-4);
		background: var(--screen-bg);
		text-align: center;
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

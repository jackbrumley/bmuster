<script lang="ts">
	import { flushSync, onMount } from 'svelte';
	import { resolve } from '$app/paths';
	import { MediaQuery } from 'svelte/reactivity';
	import { hasPermission, type Permission } from '#lib/domain/access/access.ts';
	import type {
		DesktopSettings as PictureSettings,
		InputMessage
	} from '#lib/domain/desktop/messages.ts';
	import { displayChoices, shownSize } from '#lib/domain/desktop/displays.ts';
	import type { DesktopMode } from '#lib/domain/sessions/session.ts';
	import { signedInUserOf } from '#lib/domain/machines/machine.ts';
	import { confirmAction } from '#lib/ui/confirm-action.svelte.ts';
	import { showToast } from '#lib/ui/toast.svelte.ts';
	import { machinePresence } from '#lib/runes/machine-presence.svelte.ts';
	import { consoleSessionRoute } from '#lib/runes/session-link.svelte.ts';
	import MachineUnreachable from '../machine-unreachable.svelte';
	import ClipboardPanel from './clipboard-panel.svelte';
	import NoPermission from '../no-permission.svelte';
	import { DesktopCanvas } from './desktop-canvas.ts';
	import { DesktopSession } from './desktop-session.svelte.ts';
	import DesktopSettings from './desktop-settings.svelte';
	import DesktopStart from './desktop-start.svelte';
	import FloatingControls from './floating-controls.svelte';
	import FullScreenBar from './full-screen-bar.svelte';
	import { LocalCursor } from './local-cursor.ts';
	import { FullScreen } from './full-screen.svelte.ts';
	import { dismissHint, hintDismissed } from './gesture-hint.ts';
	import GestureHint from './gesture-hint.svelte';
	import { attachStageInput } from './stage-input.ts';
	import { watchViewport } from './viewport-watch.ts';
	import type { Geometry, TouchMode } from './touch-gestures.ts';
	import { readTouchMode, saveTouchMode } from './touch-input.ts';
	import { NO_ZOOM, zoomTransform, type Zoom } from './zoom.ts';
	import KeysMenu from './keys-menu.svelte';
	import StageOverlay from './stage-overlay.svelte';
	import UnderScreenInput from './under-screen-input.svelte';
	import {
		connectingTitle as connectingTitleFor,
		isRunning,
		stageGeometry,
		stageViewport
	} from './stage-state.ts';
	import PhoneToolbar from './phone-toolbar.svelte';
	import SessionBar from './session-bar.svelte';
	import SessionNotices from './session-notices.svelte';
	import { PHONE_QUERY, popOutFeatures, popOutName, popOutSize, popOutUrl } from './pop-out.ts';
	import { PopOutWindow } from './pop-out-window.svelte.ts';
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
	/** The block under the bar: picture settings, the Keys menu or the clipboard, one at a time. */
	let open = $state<'none' | 'settings' | 'keys' | 'clipboard'>('none');
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
	/** A phone: Connect goes full screen, and the page keeps only Full screen and Disconnect (SPEC-DESKTOP-POPOUT 1–3). */
	const phoneLayout = new MediaQuery(PHONE_QUERY);
	const phone = $derived(phoneLayout.current);
	/** The window this tab popped the session out into (SPEC-DESKTOP-POPOUT 8). */
	const popOut = new PopOutWindow();

	const connection = $derived(session?.connection ?? { kind: 'idle' as const });
	const running = $derived(isRunning(connection));
	const watchOnly = $derived(session?.mode === 'watch');
	/** The session moved to the window this tab opened: the stage hides behind the notice. */
	const poppedOut = $derived(connection.kind === 'moved' && popOut.opened);
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

	/** Until the first picture arrives the stage waits under the veil, saying what it waits for. */
	const connectingTitle = $derived(
		connectingTitleFor(connection, frame !== undefined, machine.name)
	);

	function geometry(): Geometry | undefined {
		return stageGeometry(picture, frame, display);
	}

	function viewport(): { width: number; height: number; pixelRatio: number } {
		return stageViewport(stage, fullScreen);
	}

	function toggle(block: 'settings' | 'keys' | 'clipboard'): void {
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
		popOut.forget();
		void session?.start(mode);
		if (phone && stage !== undefined && !screenMode.on) {
			// The stage shows now, so full screen opens on it inside this tap (SPEC-DESKTOP-POPOUT 2).
			flushSync();
			void screenMode.toggle(stage);
		}
	}

	/** Opens the session in a window of its own, or focuses the one already open (SPEC-DESKTOP-POPOUT 6). */
	function popOutWindow(): void {
		const handover = session?.handover;
		if (handover === undefined) {
			return;
		}
		const size = popOutSize(frame ?? display ?? { width: 16, height: 9 }, {
			width: window.screen.availWidth,
			height: window.screen.availHeight
		});
		const page = resolve('/(console)/machines/[id]/desktop/window', { id: machine.id });
		if (!popOut.open(popOutUrl(page, handover), popOutName(machine.id), popOutFeatures(size))) {
			showToast(
				'The browser blocked the new window. Allow pop-ups for BMuster and try again.',
				'error'
			);
		}
	}

	/** Focuses the open window; once it is closed, takes the session back here. */
	function bringBack(): void {
		if (popOut.closed) {
			popOut.forget();
			void session?.takeBack();
		} else {
			popOut.focus();
		}
	}

	function closePopOut(): void {
		popOut.close();
		popOut.forget();
		void session?.takeBack();
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

	// A window left open keeps its own session; this page only stops watching it.
	onMount(() => () => {
		popOut.forget();
	});

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
		const cursor = new LocalCursor(surface, cursorCanvas, {
			geometry,
			zoom: () => zoom,
			controlling: () => session?.controlling === true
		});
		const current = new DesktopSession(
			machine.id,
			new DesktopCanvas(screenCanvas, cursor),
			cursor,
			viewport,
			consoleSessionRoute('desktop', machine.id)
		);
		session = current;
		void current.resume();

		const detachInput = attachStageInput(surface, current, {
			geometry,
			touchMode: () => touchMode,
			zoom: (next) => {
				zoom = next;
			},
			cursor
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
			cursor.detach();
		};
	});
</script>

{#if !canWatch}
	<NoPermission />
{:else if presenceStatus.kind !== 'online'}
	<MachineUnreachable status={presenceStatus} detail="The desktop opens when it is back." />
{:else}
	<div class="session">
		{#if phone && running}
			<PhoneToolbar
				onfullscreen={() => void toggleFullScreen()}
				ondisconnect={() => void endSession()}
			/>
		{/if}
		<SessionBar
			hidden={phone}
			{connection}
			throughput={session?.throughput}
			mode={session?.mode}
			{running}
			{canControl}
			{choosing}
			{fullScreen}
			screen={screenState}
			displays={displayOptions}
			display={session?.current ?? null}
			{keysOpen}
			clipboardOpen={open === 'clipboard'}
			settingsOpen={open === 'settings'}
			ondisplay={(id: string) => session?.selectDisplay(id)}
			onswitch={switchMode}
			onkeys={() => {
				toggle('keys');
			}}
			onclipboard={() => {
				toggle('clipboard');
			}}
			onsettings={() => {
				toggle('settings');
			}}
			onfullscreen={() => void toggleFullScreen()}
			onpopout={popOutWindow}
			ondisconnect={() => void endSession()}
		/>

		<SessionNotices
			{connection}
			{running}
			{poppedOut}
			popOutClosed={popOut.closed}
			problem={session?.problem}
			stalled={session?.stalled === true}
			onbringback={bringBack}
			onclosepopout={closePopOut}
			ontakeback={() => void session?.takeBack()}
			onresume={() => session?.requestKeyframe()}
		/>

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

		{#if open === 'clipboard' && session !== undefined && running && !watchOnly && !fullScreen}
			<ClipboardPanel clipboard={session.clipboard} />
		{/if}

		{#if keysOpen && !fullScreen}
			<KeysMenu osFamily={machine.osFamily} send={sendInput} afterSend={backToScreen} />
		{/if}

		{#if showHint && !fullScreen && !phone}
			<GestureHint ondismiss={putHintAway} />
		{/if}

		<div
			class="stage"
			class:full={fullScreen}
			class:filling={screenMode.filling}
			class:hidden={choosing || poppedOut}
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
			</div>
			{#if showHint && fullScreen}
				<div class="hint-over">
					<GestureHint ondismiss={putHintAway} />
				</div>
			{/if}
			<StageOverlay
				screen={screenState}
				waiting={connectingTitle}
				onapprove={() => session?.askApproval()}
			/>
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
					clipboard={session.clipboard}
					{backToScreen}
					ontouchmode={chooseTouchMode}
					ondisplay={(id: string) => session?.selectDisplay(id)}
					onsettings={(next: PictureSettings) => session?.changeSettings(next)}
					onswitch={switchMode}
					exit="full-screen"
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

		{#if running && !watchOnly && !phone}
			<UnderScreenInput
				osFamily={machine.osFamily}
				send={sendInput}
				{touchMode}
				ontouchmode={chooseTouchMode}
			/>
		{/if}
	</div>
{/if}

<style>
	.session {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: var(--space-3);
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

	/* Over the screen in full screen, under the controls button (z-index 2). */
	.hint-over {
		position: absolute;
		top: calc(var(--space-3) + var(--safe-top));
		left: 50%;
		z-index: 1;
		width: min(340px, calc(100% - var(--space-12) - var(--space-12)));
		transform: translateX(-50%);
	}
</style>

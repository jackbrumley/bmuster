<script lang="ts">
	import { onMount } from 'svelte';
	import { hasPermission } from '#lib/domain/access/access.ts';
	import type {
		DesktopSettings as PictureSettings,
		InputMessage
	} from '#lib/domain/desktop/messages.ts';
	import { displayChoices, shownSize } from '#lib/domain/desktop/displays.ts';
	import type { DesktopMode } from '#lib/domain/sessions/session.ts';
	import { signedInUserOf } from '#lib/domain/machines/machine.ts';
	import WindowFrame from '#lib/shell/window-frame.svelte';
	import Button from '#lib/ui/button.svelte';
	import { confirmAction } from '#lib/ui/confirm-action.svelte.ts';
	import Notice from '#lib/ui/notice.svelte';
	import { consoleSessionRoute } from '#lib/runes/session-link.svelte.ts';
	import { DesktopCanvas } from '../desktop-canvas.ts';
	import { DesktopSession } from '../desktop-session.svelte.ts';
	import { LocalCursor } from '../local-cursor.ts';
	import DesktopStart from '../desktop-start.svelte';
	import FloatingControls from '../floating-controls.svelte';
	import { handoverFrom } from '../pop-out.ts';
	import { attachStageInput } from '../stage-input.ts';
	import StageOverlay from '../stage-overlay.svelte';
	import { connectingTitle, isRunning, stageGeometry } from '../stage-state.ts';
	import type { TouchMode } from '../touch-gestures.ts';
	import { NO_ZOOM, zoomTransform, type Zoom } from '../zoom.ts';
	import type { PageProps } from './$types';

	/**
	 * The machine's screen in a window of its own (SPEC-DESKTOP-POPOUT 9–12):
	 * the tab's Pop out opens it with the running session in its address,
	 * and it joins that session the way a reload does, so the session moves
	 * here rather than doubling. Only the picture, fitted to the window, and
	 * the floating controls of full screen; no console around it.
	 */
	let { data }: PageProps = $props();

	/** A window being dragged to a new size settles before the stream is fitted again. */
	const RESIZE_SETTLE_MS = 250;

	const machine = $derived(data.machine);
	const canControl = $derived(hasPermission(data.grants, 'desktop-control'));

	let stage = $state<HTMLElement>();
	let picture = $state<HTMLElement>();
	let screenCanvas = $state<HTMLCanvasElement>();
	let cursorCanvas = $state<HTMLCanvasElement>();
	let session = $state<DesktopSession>();
	let touchMode = $state<TouchMode>('trackpad');
	let zoom = $state<Zoom>(NO_ZOOM);

	const connection = $derived(session?.connection ?? { kind: 'idle' as const });
	const live = $derived(isRunning(connection));
	const frameSize = $derived(session?.frameSize);
	const screens = $derived(displayChoices(session?.displays ?? [], session?.allScreens ?? false));
	const waiting = $derived(connectingTitle(connection, frameSize !== undefined, machine.name));

	/** The rules for this mode ask the person at the screen first (BMuster cannot ask yet). */
	const asksFirst = $derived(
		data.grants.some(
			(grant) =>
				grant.permission === (canControl ? 'desktop-control' : 'desktop-view') &&
				grant.consent === 'ask'
		)
	);

	function sendInput(message: InputMessage): void {
		session?.input(message);
	}

	function focusScreen(): void {
		stage?.focus();
	}

	async function disconnect(): Promise<void> {
		const yes = await confirmAction({
			title: 'Disconnect from this screen?',
			message: 'The session ends, and the notice on the machine goes away.',
			confirmLabel: 'Disconnect'
		});
		if (yes) {
			session?.end();
		}
	}

	onMount(() => {
		const surface = stage;
		const box = picture;
		if (
			surface === undefined ||
			box === undefined ||
			screenCanvas === undefined ||
			cursorCanvas === undefined
		) {
			return;
		}
		const geometry = () =>
			stageGeometry(box, session?.frameSize, shownSize(session?.displays ?? [], session?.current));
		const cursor = new LocalCursor(surface, cursorCanvas, {
			geometry,
			zoom: () => zoom,
			controlling: () => session?.controlling === true
		});
		const current = new DesktopSession(
			machine.id,
			new DesktopCanvas(screenCanvas, cursor),
			cursor,
			() => ({
				width: Math.round(surface.clientWidth),
				height: Math.round(surface.clientHeight),
				pixelRatio: window.devicePixelRatio
			}),
			consoleSessionRoute('desktop', machine.id)
		);
		session = current;
		const handedOver = handoverFrom(new URLSearchParams(window.location.search));
		if (handedOver !== undefined) {
			current.adopt(handedOver);
		}
		void current.resume();

		const detachInput = attachStageInput(surface, current, {
			geometry,
			touchMode: () => touchMode,
			zoom: (next) => {
				zoom = next;
			},
			cursor
		});
		// The window resized: once it settles, the agent fits the stream to it again.
		let settle: ReturnType<typeof setTimeout> | undefined;
		const resized = new ResizeObserver(() => {
			clearTimeout(settle);
			settle = setTimeout(() => {
				current.viewportChanged();
			}, RESIZE_SETTLE_MS);
		});
		resized.observe(surface);
		surface.focus();
		return () => {
			clearTimeout(settle);
			resized.disconnect();
			detachInput();
			current.detach();
			cursor.detach();
		};
	});
</script>

<svelte:head>
	<title>{machine.name}</title>
</svelte:head>

<WindowFrame>
	<div
		class="stage"
		class:watching={session?.mode === 'watch'}
		bind:this={stage}
		role="application"
		aria-label="Screen of {machine.name}"
		aria-busy={waiting !== undefined}
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
		<StageOverlay
			screen={live ? session?.screen : undefined}
			{waiting}
			onapprove={() => session?.askApproval()}
		/>
		{#if session !== undefined}
			<FloatingControls
				osFamily={machine.osFamily}
				mode={live ? session.mode : undefined}
				canSwitch={canControl}
				{touchMode}
				displays={screens}
				display={session.current ?? null}
				autoLevel={session.autoLevel}
				settings={session.settings}
				clipboard={session.clipboard}
				agentVersion={machine.agentVersion}
				send={sendInput}
				backToScreen={focusScreen}
				ontouchmode={(next: TouchMode) => (touchMode = next)}
				ondisplay={(id: string) => session?.selectDisplay(id)}
				onsettings={(next: PictureSettings) => session?.changeSettings(next)}
				onswitch={(mode: DesktopMode) => void session?.switchMode(mode)}
				exit="window"
				onexit={() => {
					window.close();
				}}
				ondisconnect={() => void disconnect()}
			/>
		{/if}
	</div>

	{#if !live && session !== undefined}
		<div class="over">
			{#if connection.kind === 'moved'}
				<Notice tone="info" title="This session is back in another window or tab.">
					<div class="actions">
						<Button
							variant="primary"
							size="compact"
							type="button"
							onclick={() => void session?.takeBack()}>Use it here</Button
						>
						<Button
							variant="secondary"
							size="compact"
							type="button"
							onclick={() => {
								window.close();
							}}>Close window</Button
						>
					</div>
				</Notice>
			{:else}
				{#if connection.kind === 'ended'}
					<Notice tone="info" title={connection.message} children={undefined} />
				{/if}
				<DesktopStart
					user={signedInUserOf(machine)}
					{canControl}
					{asksFirst}
					onstart={(mode: DesktopMode) => void session?.start(mode)}
				/>
			{/if}
		</div>
	{:else if session?.problem !== undefined}
		<div class="over">
			<Notice tone="warning" title={session.problem} children={undefined} />
		</div>
	{:else if session?.stalled === true}
		<div class="over">
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
		</div>
	{/if}
</WindowFrame>

<style>
	/* The picture fills the window, letterboxed in the screen colour. */
	.stage {
		position: relative;
		grid-area: 1 / 1;
		min-width: 0;
		min-height: 0;
		overflow: hidden;
		background: var(--screen-bg);
	}

	.stage:not(.watching) {
		touch-action: none;
	}

	.stage:focus-visible {
		outline-offset: -2px;
	}

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

	/* Messages and the start panel float over the picture, under the controls button. */
	.over {
		position: relative;
		z-index: 1;
		display: grid;
		gap: var(--space-3);
		grid-area: 1 / 1;
		align-self: center;
		justify-self: center;
		width: min(30rem, calc(100% - var(--space-8)));
		color: var(--text);
	}

	.actions {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-2);
		margin-top: var(--space-2);
	}
</style>

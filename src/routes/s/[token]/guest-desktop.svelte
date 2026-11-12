<script lang="ts">
	import { onMount } from 'svelte';
	import { resolve } from '$app/paths';
	import { IconArrowsMaximize, IconArrowsMinimize, IconEye } from '@tabler/icons-svelte-runes';
	import type { OsFamily } from '#lib/domain/machines/machine.ts';
	import { shownSize } from '#lib/domain/desktop/displays.ts';
	import type { DesktopMode } from '#lib/domain/sessions/session.ts';
	import type { SessionRoute } from '#lib/runes/session-link.svelte.ts';
	import Button from '#lib/ui/button.svelte';
	import LoadingVeil from '#lib/ui/loading-veil.svelte';
	import Notice from '#lib/ui/notice.svelte';
	import { DesktopCanvas } from '../../(console)/machines/[id]/desktop/desktop-canvas.ts';
	import { DesktopSession } from '../../(console)/machines/[id]/desktop/desktop-session.svelte.ts';
	import { FullScreen } from '../../(console)/machines/[id]/desktop/full-screen.svelte.ts';
	import KeyBar from '../../(console)/machines/[id]/desktop/key-bar.svelte';
	import { attachScreenInput } from '../../(console)/machines/[id]/desktop/screen-input.ts';
	import ToolButton from '../../(console)/machines/[id]/desktop/tool-button.svelte';
	import type { Geometry } from '../../(console)/machines/[id]/desktop/touch-gestures.ts';
	import { NO_ZOOM, zoomTransform, type Zoom } from '../../(console)/machines/[id]/desktop/zoom.ts';

	/**
	 * The guest's view of the shared machine's screen (SPEC-SHARE-LINKS SL18):
	 * the console's own desktop session, drawing and input, over the link's
	 * guest endpoints. Watch, or Control when the link allows it. The server
	 * and the agent enforce the link's permissions whatever this page does.
	 */
	let {
		token,
		machineName,
		osFamily,
		canControl
	}: {
		token: string;
		machineName: string;
		osFamily: OsFamily;
		canControl: boolean;
	} = $props();

	let stage = $state<HTMLElement>();
	let screenCanvas = $state<HTMLCanvasElement>();
	let cursorCanvas = $state<HTMLCanvasElement>();
	let picture = $state<HTMLElement>();
	let session = $state<DesktopSession>();
	let zoom = $state<Zoom>(NO_ZOOM);
	const screenMode = new FullScreen(() => session?.viewportChanged());
	const fullScreen = $derived(screenMode.on);

	const connection = $derived(session?.connection ?? { kind: 'idle' as const });
	const running = $derived(
		connection.kind === 'live' ||
			connection.kind === 'connecting' ||
			connection.kind === 'starting' ||
			connection.kind === 'reconnecting'
	);
	const choosing = $derived(connection.kind === 'idle' || connection.kind === 'ended');
	const watchOnly = $derived(session?.mode === 'watch');
	const frame = $derived(session?.frameSize);
	const display = $derived(shownSize(session?.displays ?? [], session?.current));
	const waitingTitle = $derived(
		running && frame === undefined ? `Connecting to ${machineName}` : undefined
	);

	function route(): SessionRoute {
		return {
			openUrl: resolve('/s/[token]/session', { token }),
			ticket: (sessionId) => ({
				url: resolve('/s/[token]/browser-ticket', { token }),
				body: { sessionId }
			}),
			storageKey: 'bmuster.guest.desktop'
		};
	}

	function geometry(): Geometry | undefined {
		if (picture === undefined || display === undefined || frame === undefined) {
			return undefined;
		}
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

	function start(mode: DesktopMode): void {
		void session?.start(mode);
	}

	async function toggleFullScreen(): Promise<void> {
		if (stage !== undefined) {
			await screenMode.toggle(stage);
		}
	}

	onMount(() => {
		const surface = stage;
		if (surface === undefined || screenCanvas === undefined || cursorCanvas === undefined) {
			return;
		}
		const current = new DesktopSession(
			'shared-machine',
			new DesktopCanvas(screenCanvas, cursorCanvas),
			viewport,
			route()
		);
		session = current;
		void current.resume();
		const detachInput = attachScreenInput(surface, {
			send: (message) => {
				current.input(message);
			},
			controlling: () => current.controlling,
			geometry,
			touchMode: () => 'trackpad',
			zoom: (next) => {
				zoom = next;
			}
		});
		const detachFullScreen = screenMode.attach();
		return () => {
			detachInput();
			detachFullScreen();
			current.detach();
		};
	});
</script>

<div class="guest-desktop">
	{#if connection.kind === 'ended'}
		<Notice tone="info" title={connection.message} children={undefined} />
	{/if}

	{#if choosing}
		<div class="choose">
			<Button variant="primary" size="compact" type="button" onclick={() => start('watch')}
				><IconEye size={18} /> Watch the screen</Button
			>
			{#if canControl}
				<Button variant="secondary" size="compact" type="button" onclick={() => start('control')}
					>Control the screen</Button
				>
			{/if}
		</div>
	{/if}

	{#if running}
		<div class="bar">
			{#if watchOnly}
				<span class="badge"><IconEye size={16} /> View only</span>
			{/if}
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
			<Button variant="secondary" size="compact" type="button" onclick={() => session?.end()}
				>Disconnect</Button
			>
		</div>
	{/if}

	<div
		class="stage"
		class:hidden={!running}
		class:full={fullScreen}
		class:filling={screenMode.filling}
		class:watching={watchOnly}
		bind:this={stage}
		style:aspect-ratio={fullScreen
			? undefined
			: frame !== undefined
				? `${frame.width} / ${frame.height}`
				: '16 / 9'}
		role="application"
		aria-label="Screen of {machineName}"
		aria-busy={waitingTitle !== undefined}
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
		{#if waitingTitle !== undefined}
			<div class="connecting">
				<LoadingVeil active={true} title={waitingTitle} detail={undefined} children={undefined} />
			</div>
		{/if}
	</div>

	{#if running && !watchOnly}
		<div class="phone-keys">
			<KeyBar {osFamily} send={(message) => session?.input(message)} onkeyboard={undefined} />
		</div>
	{/if}
</div>

<style>
	.guest-desktop {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: var(--space-3);
	}

	.choose,
	.bar {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: flex-end;
		gap: var(--space-2);
	}

	.choose {
		justify-content: flex-start;
	}

	.badge {
		display: inline-flex;
		align-items: center;
		gap: var(--space-1);
		margin-right: auto;
		padding: var(--space-1) var(--space-3);
		border-radius: var(--radius-pill);
		background: var(--surface-muted);
		color: var(--text-soft);
		font-size: var(--text-xs);
		font-weight: var(--weight-medium);
	}

	.stage {
		position: relative;
		width: 100%;
		max-height: 78vh;
		margin: 0 auto;
		border-radius: var(--radius-inner);
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

	.stage.filling .picture {
		top: var(--safe-top);
		right: var(--safe-right);
		bottom: var(--safe-bottom);
		left: var(--safe-left);
	}

	.stage:not(.watching) {
		touch-action: none;
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

	.connecting {
		position: absolute;
		inset: 0;
		display: grid;
	}

	@media (min-width: 900px) {
		.phone-keys {
			display: none;
		}
	}
</style>

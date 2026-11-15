<script lang="ts">
	import { flushSync, onMount, type Snippet } from 'svelte';
	import { MediaQuery } from 'svelte/reactivity';
	import { shownSize } from '#lib/domain/desktop/displays.ts';
	import type { InputMessage } from '#lib/domain/desktop/messages.ts';
	import type { DesktopMode } from '#lib/domain/sessions/session.ts';
	import type { SessionRoute } from '#lib/runes/session-link.svelte.ts';
	import { showToast } from '#lib/ui/toast.svelte.ts';
	import { attachClipboardSharing } from './clipboard.svelte.ts';
	import { DesktopCanvas } from './desktop-canvas.ts';
	import { DesktopFiles, sendBlock } from './desktop-files.svelte.ts';
	import { DesktopSession } from './desktop-session.svelte.ts';
	import { attachDropGuard } from './drop-guard.ts';
	import DropOverlay from './drop-overlay.svelte';
	import { FullScreen } from './full-screen.svelte.ts';
	import { dismissHint, hintDismissed } from './gesture-hint.ts';
	import { LocalCursor } from './local-cursor.ts';
	import {
		handoverFrom,
		PHONE_QUERY,
		popOutFeatures,
		popOutName,
		popOutSize,
		popOutUrl
	} from './pop-out.ts';
	import { PopOutWindow } from './pop-out-window.svelte.ts';
	import SessionChromeView from './session-chrome.svelte';
	import {
		SessionChrome,
		type ChromeExit,
		type ChromeLayout,
		type ChromeMachine,
		type MovedNotice
	} from './session-chrome.svelte.ts';
	import { SHEET_QUERY } from './sheet-layout.ts';
	import { attachStageInput } from './stage-input.ts';
	import type { TouchMode } from './touch-gestures.ts';
	import StageOverlay from './stage-overlay.svelte';
	import { connectingTitle, stageGeometry, stageViewport } from './stage-state.ts';
	import UnderScreenInput from './under-screen-input.svelte';
	import { watchViewport } from './viewport-watch.ts';
	import { NO_ZOOM, zoomTransform, type Zoom } from './zoom.ts';

	/**
	 * One desktop view (SPEC-DESKTOP 23.4, 1): the machine's screen drawn on
	 * a canvas, the session, input, full screen, the drop zone and the
	 * session's controls (`session-chrome.svelte`). The console's tab, the
	 * pop-out window and the share-link page all render this; they differ
	 * only in their frame, how a session starts, what files are allowed and
	 * whether Pop out is offered, so every feature reaches every view.
	 */

	/** Files through the screen: a machine's own session, or none at all (a share link). */
	type ViewFiles = { kind: 'machine'; canFiles: boolean } | { kind: 'none'; refusal: string };

	/** Where the view sits: in a page (the tab, a share link) or as a window of its own. */
	type ViewFrame =
		| {
				kind: 'page';
				/** The pop-out window's page, where the session may pop out (the console's tab). */
				popOutPage: string | undefined;
		  }
		| { kind: 'window' };

	let {
		machine,
		route,
		canControl,
		files,
		frame,
		start
	}: {
		machine: ChromeMachine;
		route: SessionRoute;
		canControl: boolean;
		files: ViewFiles;
		frame: ViewFrame;
		/** What shows while no session runs; it calls `begin` with the mode to start. */
		start: Snippet<[(mode: DesktopMode) => void]>;
	} = $props();

	/** How often copied files are looked for while Share clipboard is on. */
	const OFFER_EVERY_MS = 2000;

	let stage = $state<HTMLElement>();
	let picture = $state<HTMLElement>();
	let screenCanvas = $state<HTMLCanvasElement>();
	let cursorCanvas = $state<HTMLCanvasElement>();
	let session = $state<DesktopSession>();
	/** The picture's pinch zoom, drawn here only (SPEC-DESKTOP-FLOATING, option A). */
	let zoom = $state<Zoom>(NO_ZOOM);
	/** This browser has put the touch gestures hint away; read on mount. */
	let hintGone = $state(true);
	/** A file was dropped where files cannot be sent at all. */
	let dropRefused = $state(false);

	const inWindow = $derived(frame.kind === 'window');
	/** The browser's full screen, or the stage filling the window where there is none. */
	const screenMode = new FullScreen(() => session?.viewportChanged());
	const fullScreen = $derived(screenMode.on);
	/** A phone or a narrow window: the controls button and its sheet, never the floating bar (SPEC-DESKTOP-FLOATING FB8). */
	const sheetForm = new MediaQuery(SHEET_QUERY);
	/** A finger is the main pointer: the gestures hint is for this device. */
	const touchDevice = new MediaQuery('(pointer: coarse)');
	/** A phone: Connect goes full screen, and the page keeps only Full screen and Disconnect (SPEC-DESKTOP-POPOUT 1–3). */
	const phoneLayout = new MediaQuery(PHONE_QUERY);
	const phone = $derived(phoneLayout.current && !inWindow);
	/** The window this tab popped the session out into (SPEC-DESKTOP-POPOUT 8). */
	const popOut = new PopOutWindow();

	/** Files sent through the screen (SPEC-SESSION-FILES); what a view allows is fixed while it shows. */
	function filesFor(): DesktopFiles | undefined {
		if (files.kind === 'none') {
			return undefined;
		}
		const canFiles = files.canFiles;
		return new DesktopFiles(() => machine, {
			block: () =>
				sendBlock({
					canFiles,
					canControl,
					running: chrome.running,
					watchOnly: chrome.watchOnly
				}),
			sessionId: () => session?.handover?.sessionId,
			sharing: () => session?.clipboard.sharing === true
		});
	}
	const sending = filesFor();

	const chrome = new SessionChrome({
		session: () => session,
		files: sending,
		canControl: () => canControl,
		machine: () => machine,
		focusScreen: () => {
			stage?.focus();
		}
	});

	const connection = $derived(chrome.connection);
	const running = $derived(chrome.running);
	const watchOnly = $derived(chrome.watchOnly);
	/** The session moved to the window this tab opened: the stage hides behind the notice. */
	const poppedOut = $derived(connection.kind === 'moved' && popOut.opened);
	const frameSize = $derived(session?.frameSize);
	const display = $derived(shownSize(session?.displays ?? [], session?.current));
	/** Until the first picture arrives the stage waits under the veil, saying what it waits for. */
	const waiting = $derived(connectingTitle(connection, frameSize !== undefined, machine.name));
	/** The first control session on a touch device explains the gestures, once. */
	const showHint = $derived(touchDevice.current && running && !watchOnly && !hintGone);

	/** The full screen or the window holds only the screen: the controls float over it. */
	const over = $derived(inWindow || fullScreen);
	/** What leaves the floating layouts: full screen, or the window itself. */
	const exit = $derived<ChromeExit>(
		inWindow
			? {
					kind: 'window',
					run: () => {
						window.close();
					}
				}
			: { kind: 'full-screen', run: () => void toggleFullScreen() }
	);
	const layout = $derived.by((): ChromeLayout => {
		if (over) {
			return { kind: 'floating', form: sheetForm.current ? 'sheet' : 'bar', exit };
		}
		if (phone) {
			return { kind: 'phone', onfullscreen: () => void toggleFullScreen() };
		}
		return {
			kind: 'bar',
			onfullscreen: () => void toggleFullScreen(),
			onpopout: frame.kind === 'page' && frame.popOutPage !== undefined ? popOutWindow : undefined
		};
	});
	const moved = $derived.by((): MovedNotice => {
		if (inWindow) {
			return {
				kind: 'window',
				onclose: () => {
					window.close();
				}
			};
		}
		if (poppedOut) {
			return {
				kind: 'popped-out',
				closed: popOut.closed,
				onbringback: bringBack,
				onclose: closePopOut
			};
		}
		return { kind: 'elsewhere' };
	});

	function begin(mode: DesktopMode): void {
		chrome.open = 'none';
		popOut.forget();
		void session?.start(mode);
		if (phone && stage !== undefined && !screenMode.on) {
			// The stage shows now, so full screen opens on it inside this tap (SPEC-DESKTOP-POPOUT 2).
			flushSync();
			void screenMode.toggle(stage);
		}
	}

	async function toggleFullScreen(): Promise<void> {
		if (stage !== undefined) {
			await screenMode.toggle(stage);
		}
	}

	/** Opens the session in a window of its own, or focuses the one already open (SPEC-DESKTOP-POPOUT 6). */
	function popOutWindow(): void {
		const handover = session?.handover;
		if (handover === undefined || frame.kind !== 'page' || frame.popOutPage === undefined) {
			return;
		}
		const size = popOutSize(frameSize ?? display ?? { width: 16, height: 9 }, {
			width: window.screen.availWidth,
			height: window.screen.availHeight
		});
		if (
			!popOut.open(
				popOutUrl(frame.popOutPage, handover),
				popOutName(machine.id),
				popOutFeatures(size)
			)
		) {
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

	function putHintAway(): void {
		hintGone = true;
		dismissHint();
	}

	$effect(() => {
		// A session that ends in full screen leaves it, so the start shows.
		if (fullScreen && !running) {
			void screenMode.leave();
		}
	});

	/** Clipboard sharing follows focus, taps and keys anywhere in the page (SPEC-DESKTOP 21.11). */
	$effect(() => {
		if (session === undefined) {
			return;
		}
		return attachClipboardSharing(session.clipboard);
	});

	// A window left open keeps its own session; this page only stops watching it.
	onMount(() => () => {
		popOut.forget();
	});

	/** A file dropped anywhere never opens in the page instead of the session. */
	onMount(() =>
		attachDropGuard(
			window,
			files.kind === 'none'
				? () => {
						dropRefused = true;
					}
				: undefined
		)
	);

	onMount(() => {
		hintGone = hintDismissed();
		chrome.restore();
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
		const geometry = () => stageGeometry(box, session?.frameSize, display);
		const cursor = new LocalCursor(surface, cursorCanvas, {
			geometry,
			zoom: () => zoom,
			controlling: () => session?.controlling === true
		});
		const current = new DesktopSession(
			machine.id,
			new DesktopCanvas(screenCanvas, cursor),
			cursor,
			() => stageViewport(surface, over),
			route
		);
		session = current;
		if (inWindow) {
			const handedOver = handoverFrom(new URLSearchParams(window.location.search));
			if (handedOver !== undefined) {
				current.adopt(handedOver);
			}
		}
		void current.resume();

		const detachInput = attachStageInput(surface, current, {
			geometry,
			touchMode: () => chrome.touchMode,
			zoom: (next) => {
				zoom = next;
			},
			cursor
		});
		const detachFullScreen = screenMode.attach();
		const detachDrop = sending?.attach(surface);
		const stopOffers = sending?.watch(OFFER_EVERY_MS);
		const detachViewport = watchViewport(surface, () => {
			current.viewportChanged();
		});
		if (inWindow) {
			surface.focus();
		}
		return () => {
			detachInput();
			detachFullScreen();
			detachDrop?.();
			stopOffers?.();
			detachViewport();
			current.detach();
			cursor.detach();
		};
	});
</script>

{#if !over}
	<SessionChromeView
		{chrome}
		{layout}
		{moved}
		refused={dropRefused && files.kind === 'none' ? files.refusal : undefined}
		hint={showHint && !phone ? putHintAway : undefined}
		toasts={false}
	/>
	{#if chrome.choosing}
		{@render start(begin)}
	{/if}
{/if}

<div
	class="stage"
	class:in-window={inWindow}
	class:full={fullScreen}
	class:filling={screenMode.filling}
	class:hidden={!inWindow && (chrome.choosing || poppedOut)}
	class:watching={watchOnly}
	bind:this={stage}
	style:aspect-ratio={over
		? undefined
		: frameSize !== undefined
			? `${frameSize.width} / ${frameSize.height}`
			: '16 / 9'}
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
		screen={running ? session?.screen : undefined}
		{waiting}
		onapprove={() => session?.askApproval()}
	/>
	{#if sending !== undefined}
		<DropOverlay overlay={sending.sender.overlay} machine={machine.name} />
	{/if}
	{#if over && stage !== undefined}
		<SessionChromeView
			{chrome}
			{layout}
			{moved}
			refused={dropRefused && files.kind === 'none' ? files.refusal : undefined}
			hint={showHint ? putHintAway : undefined}
			toasts={screenMode.browser}
		/>
	{/if}
</div>

{#if inWindow && chrome.choosing && session !== undefined}
	<div class="start">
		{@render start(begin)}
	</div>
{/if}

{#if !over && running && !watchOnly && !phone}
	<UnderScreenInput
		osFamily={machine.osFamily}
		send={(message: InputMessage) => {
			chrome.send(message);
		}}
		touchMode={chrome.touchMode}
		ontouchmode={(next: TouchMode) => {
			chrome.chooseTouchMode(next);
		}}
		onpaste={(text: string) => {
			session?.clipboard.pasteFromKeyboard(text);
		}}
	/>
{/if}

<style>
	.stage {
		position: relative;
		width: 100%;
		max-height: 78vh;
		margin: 0 auto;
		border-radius: var(--radius-card);
		background: var(--screen-bg);
		overflow: hidden;
	}

	/* The picture fills the window, letterboxed in the screen colour. */
	.stage.in-window {
		grid-area: 1 / 1;
		min-width: 0;
		min-height: 0;
		max-height: none;
		border-radius: 0;
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

	/* The start floats over the window's screen, under the controls. */
	.start {
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
</style>

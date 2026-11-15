<script lang="ts">
	import type { DesktopMode } from '#lib/domain/sessions/session.ts';
	import type {
		DesktopSettings as PictureSettings,
		InputMessage
	} from '#lib/domain/desktop/messages.ts';
	import ToastHost from '#lib/ui/toast-host.svelte';
	import FloatingControls from './floating-controls.svelte';
	import FullScreenBar from './full-screen-bar.svelte';
	import GestureHint from './gesture-hint.svelte';
	import PhoneToolbar from './phone-toolbar.svelte';
	import SessionBar from './session-bar.svelte';
	import type { ChromeLayout, MovedNotice, SessionChrome } from './session-chrome.svelte.ts';
	import SessionNotices from './session-notices.svelte';
	import SessionPanels from './session-panels.svelte';
	import type { TouchMode } from './touch-gestures.ts';

	/**
	 * The session's controls in one desktop view (SPEC-DESKTOP 23.4, 2), the
	 * same set in every layout: the bar above the screen, the phone bar, the
	 * floating bar over the screen, or the controls button and its sheet. The
	 * notices show in every layout, above the screen or over it. Every view
	 * renders this, once, through `desktop-view.svelte`.
	 */
	let {
		chrome,
		layout,
		moved,
		refused,
		hint,
		toasts
	}: {
		chrome: SessionChrome;
		layout: ChromeLayout;
		moved: MovedNotice;
		/** Why a dropped file was not sent, once one was. */
		refused: string | undefined;
		/** The first-time gestures hint, while it is due; undefined otherwise. */
		hint: (() => void) | undefined;
		/** The browser's own full screen holds the screen: the toasts must show inside it. */
		toasts: boolean;
	} = $props();
</script>

{#if layout.kind === 'bar' || layout.kind === 'phone'}
	{#if layout.kind === 'bar'}
		<SessionBar {chrome} onfullscreen={layout.onfullscreen} onpopout={layout.onpopout} />
	{:else if chrome.running}
		<PhoneToolbar
			onfullscreen={layout.onfullscreen}
			ondisconnect={() => void chrome.disconnect()}
		/>
	{/if}
	<SessionNotices {chrome} over={false} {moved} {refused} />
	{#if layout.kind === 'bar'}
		<SessionPanels {chrome} />
		{#if hint !== undefined}
			<GestureHint ondismiss={hint} />
		{/if}
	{/if}
{:else}
	<div class="notices">
		<SessionNotices {chrome} over={true} {moved} {refused} />
	</div>
	{#if hint !== undefined}
		<div class="hint">
			<GestureHint ondismiss={hint} />
		</div>
	{/if}
	{#if layout.kind === 'overlay'}
		<FullScreenBar {chrome} surface={layout.surface} exit={layout.exit} />
	{:else if chrome.session !== undefined}
		<FloatingControls
			actions={chrome.actions}
			status={chrome.status}
			waiting={chrome.waiting?.text}
			transfers={chrome.files?.sheetTransfers}
			osFamily={chrome.machine.osFamily}
			mode={chrome.mode}
			canSwitch={chrome.canControl}
			touchMode={chrome.touchMode}
			displays={chrome.displays}
			display={chrome.display}
			settings={chrome.session.settings}
			autoLevel={chrome.session.autoLevel}
			agentVersion={chrome.machine.agentVersion}
			send={(message: InputMessage) => {
				chrome.send(message);
			}}
			clipboard={chrome.session.clipboard}
			backToScreen={() => {
				chrome.focusScreen();
			}}
			ontouchmode={(next: TouchMode) => {
				chrome.chooseTouchMode(next);
			}}
			ondisplay={(id: string) => {
				chrome.selectDisplay(id);
			}}
			onsettings={(next: PictureSettings) => {
				chrome.changeSettings(next);
			}}
			onswitch={(next: DesktopMode) => {
				chrome.switchMode(next);
			}}
			exit={layout.exit.kind}
			onexit={layout.exit.run}
			ondisconnect={() => void chrome.disconnect()}
			files={chrome.files?.sheet}
		/>
	{/if}
	{#if toasts}
		<ToastHost />
	{/if}
{/if}

<style>
	/* Over the screen at the bottom, clear of the bar at the top; under the controls (z-index 2). */
	.notices {
		position: absolute;
		bottom: calc(var(--space-4) + var(--safe-bottom));
		left: 50%;
		z-index: 1;
		display: grid;
		gap: var(--space-2);
		width: min(30rem, calc(100% - var(--space-8)));
		transform: translateX(-50%);
		pointer-events: none;
	}

	.notices > :global(*) {
		pointer-events: auto;
	}

	.hint {
		position: absolute;
		top: calc(var(--space-3) + var(--safe-top));
		left: 50%;
		z-index: 1;
		width: min(340px, calc(100% - var(--space-12) - var(--space-12)));
		transform: translateX(-50%);
	}
</style>

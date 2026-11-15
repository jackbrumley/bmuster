<script lang="ts">
	import type {
		DesktopSettings as PictureSettings,
		InputMessage
	} from '#lib/domain/desktop/messages.ts';
	import ClipboardPanel from './clipboard-panel.svelte';
	import { CONTROLS_SHORTCUT } from './controls-shortcut.ts';
	import DesktopSettings from './desktop-settings.svelte';
	import KeyBar from './key-bar.svelte';
	import KeysMenu from './keys-menu.svelte';
	import type { SessionChrome } from './session-chrome.svelte.ts';
	import type { TouchMode } from './touch-gestures.ts';
	import TouchInputChoice from './touch-input-choice.svelte';
	import TransfersPanel from './transfers-panel.svelte';

	/**
	 * What the bar's tools open, under the tab's bar and under the floating
	 * bar alike (SPEC-DESKTOP 23): picture settings, the Keys menu or the
	 * clipboard (one at a time), and the Transfers panel. On a touch screen
	 * the floating bar's Keys panel also holds the phone keys with the
	 * keyboard toggle and the touch input choice (SPEC-DESKTOP-FLOATING FB8),
	 * which the page shows under the screen instead.
	 */
	let {
		chrome,
		touch,
		floating
	}: {
		chrome: SessionChrome;
		touch: boolean;
		/** Under the floating bar: the Keys panel tells of the shortcut that collapses it (FB14). */
		floating: boolean;
	} = $props();

	function send(message: InputMessage): void {
		chrome.send(message);
	}
</script>

{#if chrome.panel === 'settings' && chrome.session !== undefined}
	<DesktopSettings
		settings={chrome.session.settings}
		autoLevel={chrome.session.autoLevel}
		agentVersion={chrome.machine.agentVersion}
		onchange={(next: PictureSettings) => {
			chrome.changeSettings(next);
		}}
	/>
{:else if chrome.panel === 'clipboard' && chrome.session !== undefined}
	<ClipboardPanel clipboard={chrome.session.clipboard} getCopied={chrome.getCopied} />
{:else if chrome.panel === 'keys'}
	{#if touch && chrome.session !== undefined}
		{@const clipboard = chrome.session.clipboard}
		<div class="touch">
			<KeyBar
				osFamily={chrome.machine.osFamily}
				{send}
				onkeyboard={undefined}
				onpaste={(text: string) => {
					clipboard.pasteFromKeyboard(text);
				}}
			/>
			<TouchInputChoice
				value={chrome.touchMode}
				onchange={(next: TouchMode) => {
					chrome.chooseTouchMode(next);
				}}
			/>
		</div>
	{/if}
	<KeysMenu
		osFamily={chrome.machine.osFamily}
		{send}
		afterSend={() => {
			chrome.focusScreen();
		}}
		footnote={floating
			? `${CONTROLS_SHORTCUT} collapses and expands these controls; it is never sent to the machine.`
			: undefined}
	/>
{/if}
{#if chrome.transfersOpen && chrome.files !== undefined}
	<TransfersPanel sender={chrome.files.sender} />
{/if}

<style>
	.touch {
		display: grid;
		gap: var(--space-2);
		padding: var(--space-2);
		border-radius: var(--radius-inner);
		background: var(--surface-elevated);
	}
</style>

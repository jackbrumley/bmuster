<script lang="ts">
	import type {
		DesktopSettings as PictureSettings,
		InputMessage
	} from '#lib/domain/desktop/messages.ts';
	import ClipboardPanel from './clipboard-panel.svelte';
	import DesktopSettings from './desktop-settings.svelte';
	import KeysMenu from './keys-menu.svelte';
	import type { SessionChrome } from './session-chrome.svelte.ts';
	import TransfersPanel from './transfers-panel.svelte';

	/**
	 * What the bar's tools open, under the tab's bar and under the floating
	 * bar alike (SPEC-DESKTOP 23): picture settings, the Keys menu or the
	 * clipboard (one at a time), and the Transfers panel.
	 */
	let { chrome }: { chrome: SessionChrome } = $props();
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
	<KeysMenu
		osFamily={chrome.machine.osFamily}
		send={(message: InputMessage) => {
			chrome.send(message);
		}}
		afterSend={() => {
			chrome.focusScreen();
		}}
	/>
{/if}
{#if chrome.transfersOpen && chrome.files !== undefined}
	<TransfersPanel sender={chrome.files.sender} />
{/if}

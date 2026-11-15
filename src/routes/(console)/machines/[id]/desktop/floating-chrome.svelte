<script lang="ts">
	import { onMount, tick } from 'svelte';
	import { MediaQuery } from 'svelte/reactivity';
	import type {
		DesktopSettings as PictureSettings,
		InputMessage
	} from '#lib/domain/desktop/messages.ts';
	import type { DesktopMode } from '#lib/domain/sessions/session.ts';
	import { attachControlsShortcut } from './controls-shortcut.ts';
	import FloatingBar from './floating-bar.svelte';
	import FloatingControls from './floating-controls.svelte';
	import {
		readControls,
		rememberControls,
		type BarOpening,
		type ControlsMemory
	} from './floating-memory.ts';
	import type { FloatingPosition } from './floating-position.ts';
	import type { ChromeExit, SessionChrome } from './session-chrome.svelte.ts';
	import type { TouchMode } from './touch-gestures.ts';

	/**
	 * The session's controls over the screen, in full screen and in the
	 * pop-out (SPEC-DESKTOP-FLOATING FB2–FB9): one control in two shapes.
	 * Expanded, the bar (`floating-bar.svelte`); collapsed, the round button
	 * (`floating-controls.svelte`), which sits where the bar's grip was and
	 * whose tap expands the bar with its grip on it. On phones and narrow
	 * windows (`form` 'sheet') it is always the button, and a tap opens the
	 * sheet instead. Which shape shows and where each sits is
	 * remembered in this browser, for full screen and the pop-out apart, per
	 * machine (FB15).
	 * Ctrl+Alt+Home collapses and expands the bar from the keyboard (FB14).
	 */
	let { chrome, form, exit }: { chrome: SessionChrome; form: 'bar' | 'sheet'; exit: ChromeExit } =
		$props();

	/** A finger is the main pointer: the bar starts collapsed, and its Keys panel adds the phone keys. */
	const touch = new MediaQuery('(pointer: coarse)');

	/** Read on mount; until then nothing shows, so the controls never jump from the defaults. */
	let memory = $state<ControlsMemory>();
	let opened = $state<BarOpening>({ kind: 'restored' });
	/** The round button, focused after Enter or Space collapsed the bar. */
	let fab = $state<HTMLButtonElement>();
	/** Set by the expanded bar, which works out where the button goes when the shortcut collapses it. */
	let collapseBar = $state<(keyboard: boolean) => void>();

	const expanded = $derived(form === 'bar' && memory?.shown === 'bar');

	function remember(): void {
		if (memory !== undefined) {
			rememberControls(exit.kind, chrome.machine.id, $state.snapshot(memory));
		}
	}

	/** The button was tapped: the bar opens with its grip on the button (FB5). */
	function expand(keyboard: boolean): void {
		if (memory === undefined) {
			return;
		}
		opened = { kind: 'expanded', button: memory.button, keyboard };
		memory.shown = 'bar';
		remember();
	}

	/** The handle was tapped: the button takes the grip's place (FB4, FB5). */
	async function collapse(to: FloatingPosition, keyboard: boolean): Promise<void> {
		if (memory === undefined) {
			return;
		}
		memory.button = to;
		memory.shown = 'button';
		remember();
		await tick();
		if (keyboard) {
			fab?.focus();
		} else {
			chrome.focusScreen();
		}
	}

	onMount(() => {
		memory = readControls(exit.kind, chrome.machine.id, touch.current);
		// The shortcut keeps the keyboard where it was: on the screen, as a rule.
		return attachControlsShortcut(window, {
			active: () => form === 'bar' && memory !== undefined,
			toggle: () => {
				if (collapseBar !== undefined) {
					collapseBar(false);
				} else {
					expand(false);
				}
			}
		});
	});
</script>

{#if memory !== undefined}
	{#if expanded}
		<FloatingBar
			bind:collapser={collapseBar}
			{chrome}
			{opened}
			{exit}
			touch={touch.current}
			bind:place={memory.bar}
			onmoved={remember}
			oncollapse={(to: FloatingPosition, keyboard: boolean) => void collapse(to, keyboard)}
		/>
	{:else if chrome.session !== undefined}
		<FloatingControls
			bind:fab
			bind:position={memory.button}
			onmoved={remember}
			expand={form === 'bar' ? expand : undefined}
			actions={chrome.actions}
			status={chrome.status}
			attention={chrome.attention}
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
			exit={exit.kind}
			onexit={exit.run}
			ondisconnect={() => void chrome.disconnect()}
			files={chrome.files?.sheet}
		/>
	{/if}
{/if}

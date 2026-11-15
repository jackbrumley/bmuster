<script lang="ts">
	import type {
		AutoLevel,
		DesktopSettings as PictureSettings,
		InputMessage
	} from '#lib/domain/desktop/messages.ts';
	import type { OsFamily } from '#lib/domain/machines/machine.ts';
	import type { DesktopMode } from '#lib/domain/sessions/session.ts';
	import ChipGroup from '#lib/ui/chip-group.svelte';
	import Panel from '#lib/ui/panel.svelte';
	import TabBar from '#lib/ui/tab-bar.svelte';
	import { CONTROLS_SHORTCUT } from './controls-shortcut.ts';
	import DesktopSettings from './desktop-settings.svelte';
	import FloatingButton from './floating-button.svelte';
	import { BUTTON_SIZE, type FloatingPosition } from './floating-position.ts';
	import ClipboardPanel from './clipboard-panel.svelte';
	import type { SheetFiles, SheetTransfers } from './desktop-files.svelte.ts';
	import FloatingSessionTab from './floating-session-tab.svelte';
	import type { DesktopClipboard } from './clipboard.svelte.ts';
	import KeyBar from './key-bar.svelte';
	import KeysMenu from './keys-menu.svelte';
	import type { Attention, ChromeAction, SessionStatus } from './session-actions.ts';
	import { scrollEdges, sheetLayout, sheetTabs, type SheetTab as Tab } from './sheet-layout.ts';
	import type { TouchMode } from './touch-gestures.ts';

	/**
	 * The collapsed floating controls (SPEC-DESKTOP-FLOATING, option A and
	 * FB5–FB8): one round button over the screen that can be dragged
	 * anywhere; let go, it snaps to the nearest edge. Where the bar is
	 * offered (`expand`), a tap expands it; on phones and narrow windows a
	 * tap opens the sheet: a bottom sheet on an upright screen, a full-height
	 * side panel on a screen on its side, with tabs for the keys, the
	 * picture, the screen picker and the session, each scrolling inside the
	 * sheet with a fade where there is more. The screen's input takes only
	 * events aimed at the screen itself (`screen-input.ts`), and a drag
	 * swallows its pointer's events on the way down, so neither the button
	 * nor the sheet ever clicks on the machine. The tabs come from the
	 * session's actions (SPEC-DESKTOP 23): each action has a home tab here.
	 */
	let {
		fab = $bindable(),
		position = $bindable(),
		onmoved,
		expand,
		actions,
		status,
		attention,
		transfers,
		osFamily,
		mode,
		canSwitch,
		touchMode,
		displays,
		display,
		settings,
		autoLevel,
		agentVersion,
		send,
		clipboard,
		backToScreen,
		ontouchmode,
		ondisplay,
		onsettings,
		onswitch,
		exit,
		onexit,
		ondisconnect,
		files
	}: {
		/** The round button, for the owner to focus after collapsing the bar. */
		fab: HTMLButtonElement | undefined;
		/** Where the button sits; its owner remembers it. */
		position: FloatingPosition;
		/** A drag put the button somewhere new. */
		onmoved: () => void;
		/** Expands the bar instead of opening the sheet (wide screens); `keyboard` when a key pressed the button. */
		expand: ((keyboard: boolean) => void) | undefined;
		/** What the session offers now (`session-actions.ts`). */
		actions: readonly ChromeAction[];
		/** The session's status in a few words, for the Session tab. */
		status: SessionStatus;
		/** Something waiting (files, a clipboard notice), for the badge on the button. */
		attention: Attention | undefined;
		/** The Transfers panel, in the Session tab; undefined without files. */
		transfers: SheetTransfers | undefined;
		osFamily: OsFamily;
		/** Undefined while no session runs: then only Leave full screen shows. */
		mode: DesktopMode | undefined;
		/** The person may control, so they may change mode. */
		canSwitch: boolean;
		touchMode: TouchMode;
		/** The machine's displays; the Screen tab shows when there is more than one. */
		displays: readonly { value: string; label: string; count: undefined }[];
		display: string | null;
		settings: PictureSettings;
		/** The level Auto picked, when it is on and the agent says. */
		autoLevel: AutoLevel | undefined;
		agentVersion: string;
		send: (message: InputMessage) => void;
		/** Copy and paste with the machine: the Clipboard tab, in a control session. */
		clipboard: DesktopClipboard;
		/** Gives the keyboard back to the screen after an action. */
		backToScreen: () => void;
		ontouchmode: (mode: TouchMode) => void;
		ondisplay: (id: string) => void;
		onsettings: (settings: PictureSettings) => void;
		onswitch: (mode: DesktopMode) => void;
		/** What the exit action leaves: full screen, or the pop-out window (SPEC-DESKTOP-POPOUT 9). */
		exit: 'full-screen' | 'window';
		onexit: () => void;
		ondisconnect: () => void;
		/** Upload files and Download N files in the Session tab, Get copied files in the Clipboard tab (SPEC-SESSION-FILES). */
		files: SheetFiles | undefined;
	} = $props();

	const uid = $props.id();
	const control = $derived(mode === 'control');

	let open = $state(false);
	/** The tab the person picked; until then, or once it goes away, the opening tab. */
	let chosen = $state<Tab>();
	/** The phone's keyboard is open: the sheet folds to the key bar, at the top. */
	let typing = $state(false);
	let area = $state<HTMLElement>();
	let areaWidth = $state(0);
	let areaHeight = $state(0);
	let scroller = $state<HTMLElement>();
	/** More of the tab to see above or below: the fades show. */
	let edges = $state({ above: false, below: false });

	const tabs = $derived(sheetTabs(actions));
	/** A control session opens on its keys, or on what waits (files: Session; a clipboard notice: Clipboard); any other on Session. */
	const shown = $derived<Tab>(
		chosen !== undefined && tabs.some((tab) => tab.value === chosen)
			? chosen
			: !control || attention?.kind === 'files'
				? 'session'
				: attention?.kind === 'clipboard'
					? 'clipboard'
					: 'keys'
	);
	const layout = $derived(
		sheetLayout({ width: areaWidth, height: areaHeight }, position, BUTTON_SIZE)
	);

	function close(): void {
		open = false;
		typing = false;
	}

	function pick(tab: Tab): void {
		chosen = tab;
		scroller?.scrollTo({ top: 0 });
	}

	/** Runs an action that ends the sheet's use (switch mode, leave full screen, disconnect). */
	function leave(action: () => void): () => void {
		return () => {
			close();
			action();
		};
	}

	function measure(): void {
		if (scroller instanceof HTMLElement) {
			edges = scrollEdges(scroller);
		}
	}

	/** Escape closes the open sheet, wherever the focus is, and leaves it on the button. */
	function onWindowKey(event: KeyboardEvent): void {
		if (open && event.key === 'Escape') {
			close();
			fab?.focus();
		}
	}

	// The fades follow the tab's content as it changes (More, another tab) and the sheet's size.
	$effect(() => {
		const box = scroller;
		// bind:this sets null, not undefined, when the sheet closes.
		if (!(box instanceof HTMLElement)) {
			return;
		}
		const observer = new ResizeObserver(measure);
		observer.observe(box);
		for (const child of box.children) {
			observer.observe(child);
		}
		measure();
		return () => {
			observer.disconnect();
		};
	});

	function onTap(keyboard: boolean): void {
		if (expand !== undefined) {
			expand(keyboard);
		} else if (open) {
			close();
		} else {
			open = true;
		}
	}
</script>

<svelte:window onkeydown={onWindowKey} />

<div class="layer">
	{#if open}
		<button
			data-raw-button="backdrop"
			type="button"
			class="backdrop"
			aria-label="Close the controls"
			tabindex="-1"
			onclick={close}
		></button>
	{/if}
	<div class="area" bind:this={area} bind:clientWidth={areaWidth} bind:clientHeight={areaHeight}>
		<FloatingButton
			bind:element={fab}
			bind:position
			{area}
			{attention}
			expanded={open}
			controls={expand === undefined ? `${uid}-sheet` : undefined}
			shortcut={expand === undefined ? undefined : CONTROLS_SHORTCUT}
			ondragstart={close}
			{onmoved}
			ontap={onTap}
		/>
		{#if open}
			<div
				id="{uid}-sheet"
				class="sheet {layout.kind}"
				class:right={layout.kind === 'side' && layout.side === 'right'}
				class:typing
				role="group"
				aria-label="Session options"
			>
				<Panel heading={undefined} actions={undefined} tone="normal" padding="none">
					<div class="inner">
						{#if !typing}
							<div class="tabs">
								<TabBar
									label="Session options"
									{tabs}
									panel="{uid}-tab"
									bind:value={() => shown, pick}
								/>
							</div>
						{/if}
						<div class="scroller">
							<div
								class="scroll"
								id="{uid}-tab"
								role="tabpanel"
								aria-label={tabs.find((tab) => tab.value === shown)?.label}
								bind:this={scroller}
								onscroll={measure}
							>
								<div class="content">
									{#if shown === 'keys' && control}
										<KeyBar
											{osFamily}
											{send}
											onkeyboard={(keyboardOpen: boolean) => (typing = keyboardOpen)}
											onpaste={(text: string) => {
												clipboard.pasteFromKeyboard(text);
											}}
										/>
										{#if !typing}
											<KeysMenu {osFamily} {send} afterSend={backToScreen} footnote={undefined} />
										{/if}
									{:else if shown === 'clipboard' && control}
										<ClipboardPanel {clipboard} getCopied={files?.getCopied} />
									{:else if shown === 'picture' && mode !== undefined}
										<DesktopSettings {settings} {autoLevel} {agentVersion} onchange={onsettings} />
									{:else if shown === 'screen'}
										<ChipGroup
											label="Screen"
											options={displays}
											bind:value={
												() => display,
												(value: string | null) => {
													if (value !== null) ondisplay(value);
												}
											}
										/>
									{:else if shown === 'session'}
										<FloatingSessionTab
											{status}
											{transfers}
											{mode}
											{canSwitch}
											{touchMode}
											{exit}
											{ontouchmode}
											onswitch={(next: DesktopMode) => {
												close();
												onswitch(next);
											}}
											onexit={leave(onexit)}
											ondisconnect={leave(ondisconnect)}
											files={files === undefined
												? undefined
												: {
														upload: leave(files.upload),
														download:
															files.download === undefined
																? undefined
																: { label: files.download.label, run: leave(files.download.run) },
														getCopied: files.getCopied
													}}
										/>
									{/if}
								</div>
							</div>
							{#if edges.above}
								<div class="fade top" aria-hidden="true"></div>
							{/if}
							{#if edges.below}
								<div class="fade bottom" aria-hidden="true"></div>
							{/if}
						</div>
					</div>
				</Panel>
			</div>
		{/if}
	</div>
</div>

<style>
	.layer {
		position: absolute;
		inset: 0;
		z-index: 2;
		pointer-events: none;
	}

	.backdrop {
		position: absolute;
		inset: 0;
		padding: 0;
		border: 0;
		background: transparent;
		pointer-events: auto;
		cursor: default;
	}

	/* Where the button and the sheet may sit: the screen less the safe-area insets and a small gap. */
	.area {
		position: absolute;
		top: calc(var(--space-3) + var(--safe-top));
		right: calc(var(--space-3) + var(--safe-right));
		bottom: calc(var(--space-3) + var(--safe-bottom));
		left: calc(var(--space-3) + var(--safe-left));
		pointer-events: none;
	}

	/* An upright screen: a bottom sheet across the width, at most 70% of the height. */
	.sheet {
		position: absolute;
		right: 0;
		bottom: 0;
		left: 0;
		display: flex;
		flex-direction: column;
		max-height: 70%;
		pointer-events: auto;
	}

	/* A screen on its side: a full-height panel on the button's side. */
	.sheet.side {
		top: 0;
		right: auto;
		display: grid;
		grid-template-rows: minmax(0, 1fr);
		width: min(380px, 50%);
		max-height: none;
	}

	.sheet.side.right {
		right: 0;
		left: auto;
	}

	/* Above the phone's keyboard, which rises from the bottom. */
	.sheet.typing {
		top: 0;
		bottom: auto;
		display: flex;
		max-height: 50%;
	}

	.inner {
		display: grid;
		grid-template-rows: auto minmax(0, 1fr);
		min-height: 0;
	}

	.sheet.typing .inner {
		grid-template-rows: minmax(0, 1fr);
	}

	.tabs {
		padding: var(--space-3) var(--space-3) 0;
	}

	.scroller {
		position: relative;
		display: grid;
		grid-template-rows: minmax(0, 1fr);
		min-height: 0;
	}

	.scroll {
		min-height: 0;
		overflow-y: auto;
		overscroll-behavior: contain;
	}

	.content {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		align-content: start;
		gap: var(--space-3);
		padding: var(--space-3);
	}

	/* There is more this way: the content fades out under the edge. */
	.fade {
		position: absolute;
		right: 0;
		left: 0;
		height: var(--space-8);
		pointer-events: none;
	}

	.fade.top {
		top: 0;
		background: linear-gradient(var(--surface-elevated), transparent);
	}

	.fade.bottom {
		bottom: 0;
		background: linear-gradient(transparent, var(--surface-elevated));
	}
</style>

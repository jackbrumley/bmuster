<script lang="ts">
	import type { InputMessage } from '#lib/domain/desktop/messages.ts';
	import type { OsFamily } from '#lib/domain/machines/machine.ts';
	import Button from '#lib/ui/button.svelte';
	import ChipGroup from '#lib/ui/chip-group.svelte';
	import { confirmAction } from '#lib/ui/confirm-action.svelte.ts';
	import Panel from '#lib/ui/panel.svelte';
	import SectionHeading from '#lib/ui/section-heading.svelte';
	import {
		chordLabel,
		chordMessages,
		groupOf,
		MODIFIERS,
		modifierLabel,
		PICK_GROUPS,
		pickableKey,
		shortcutsFor,
		type Modifier,
		type PickGroupId,
		type Shortcut
	} from './keys.ts';

	/**
	 * The Keys menu (SPEC-DESKTOP-KEYS): combinations the viewer's own system
	 * would catch, a custom combination, and Release all keys. Shown only for
	 * control sessions. `afterSend` gives the keyboard back to the screen.
	 */
	let {
		osFamily,
		send,
		afterSend
	}: {
		osFamily: OsFamily;
		send: (message: InputMessage) => void;
		afterSend: () => void;
	} = $props();

	const uid = $props.id();
	const shortcuts = $derived(shortcutsFor(osFamily));

	let modifiers = $state<Modifier[]>([]);
	let group = $state<PickGroupId | null>('letters');
	let code = $state<string | null>(null);
	let listening = $state(false);

	const groups = PICK_GROUPS.map((item) => ({
		value: item.id,
		label: item.label,
		count: undefined
	}));
	const keyOptions = $derived(
		(PICK_GROUPS.find((item) => item.id === group)?.keys ?? []).map((item) => ({
			value: item.code,
			label: item.label,
			count: undefined
		}))
	);
	const picked = $derived(code === null ? undefined : pickableKey(code));
	const custom = $derived(picked === undefined ? undefined : { modifiers, key: picked });

	function sendAll(messages: readonly InputMessage[]): void {
		for (const message of messages) {
			send(message);
		}
		afterSend();
	}

	async function run(shortcut: Shortcut): Promise<void> {
		switch (shortcut.kind) {
			case 'chord':
				sendAll(chordMessages(shortcut.chord));
				return;
			case 'ctrl-alt-del': {
				if (osFamily === 'linux') {
					const yes = await confirmAction({
						title: 'Send Ctrl+Alt+Del?',
						message:
							'At a desktop it opens the session menu, but at a text console Linux treats it as a request to restart the machine.',
						confirmLabel: 'Send Ctrl+Alt+Del'
					});
					if (!yes) {
						return;
					}
				}
				// Windows: the agent's service sends it with SendSAS; Linux: the key chord.
				sendAll([{ type: 'special', name: 'ctrl-alt-del' }]);
				return;
			}
		}
	}

	function toggle(modifier: Modifier): void {
		modifiers = modifiers.includes(modifier)
			? modifiers.filter((item) => item !== modifier)
			: [...modifiers, modifier];
	}

	const HELD: readonly { modifier: Modifier; held: (event: KeyboardEvent) => boolean }[] = [
		{ modifier: 'ctrl', held: (event) => event.ctrlKey },
		{ modifier: 'alt', held: (event) => event.altKey },
		{ modifier: 'shift', held: (event) => event.shiftKey },
		{ modifier: 'win', held: (event) => event.metaKey }
	];

	/** While listening, the next pickable key becomes the key, with the modifiers held. */
	function onCaptureKey(event: KeyboardEvent): void {
		if (!listening) {
			return;
		}
		event.preventDefault();
		event.stopPropagation();
		const found = pickableKey(event.code);
		if (found === undefined) {
			return;
		}
		const held = HELD.filter((item) => item.held(event)).map((item) => item.modifier);
		if (held.length > 0) {
			modifiers = held;
		}
		code = found.code;
		group = groupOf(found.code) ?? group;
		listening = false;
	}
</script>

<Panel heading="Keys" actions={undefined} tone="normal" padding="normal">
	<div class="shortcuts">
		{#each shortcuts as shortcut (shortcut.id)}
			<Button variant="secondary" size="compact" type="button" onclick={() => void run(shortcut)}>
				<span class="shortcut">
					<span class="label">{shortcut.label}</span>
					<span class="hint">{shortcut.hint}</span>
				</span>
			</Button>
		{/each}
	</div>

	<div class="custom" role="group" aria-labelledby="{uid}-custom">
		<SectionHeading id="{uid}-custom" text="Custom combination" tone="normal" />
		<div class="modifiers" role="group" aria-label="Modifiers">
			{#each MODIFIERS as modifier (modifier)}
				<button
					data-raw-button="chip"
					type="button"
					class="chip"
					aria-pressed={modifiers.includes(modifier)}
					onclick={() => {
						toggle(modifier);
					}}>{modifierLabel(modifier, osFamily)}</button
				>
			{/each}
		</div>
		<ChipGroup label="Key group" options={groups} bind:value={group} />
		<ChipGroup label="Key" options={keyOptions} bind:value={code} />
		<div class="send">
			<button
				data-raw-button="key"
				type="button"
				class="chip"
				aria-pressed={listening}
				onclick={() => (listening = true)}
				onkeydown={onCaptureKey}
				onblur={() => (listening = false)}>{listening ? 'Press a key now…' : 'Press a key'}</button
			>
			{#if custom !== undefined}
				<Button
					variant="primary"
					size="compact"
					type="button"
					onclick={() => {
						sendAll(chordMessages(custom));
					}}>Send {chordLabel(custom, osFamily)}</Button
				>
			{:else}
				<span class="hint">Pick a key to send.</span>
			{/if}
		</div>
	</div>

	<div class="release">
		<Button
			variant="secondary"
			size="compact"
			type="button"
			onclick={() => {
				sendAll([{ type: 'release-all' }]);
			}}>Release all keys</Button
		>
	</div>
</Panel>

<style>
	.shortcuts {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(9rem, 1fr));
		gap: var(--space-2);
	}

	.shortcut {
		display: grid;
		justify-items: center;
		line-height: 1.2;
	}

	.label {
		color: var(--text);
		font-weight: var(--weight-semibold);
	}

	.hint {
		color: var(--muted);
		font-size: var(--text-xs);
	}

	.custom {
		display: grid;
		gap: var(--space-3);
	}

	.modifiers,
	.send {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-2);
	}

	.chip {
		min-width: 44px;
		min-height: 40px;
		padding: 0 var(--space-4);
		border: 1px solid var(--border);
		border-radius: var(--radius-pill);
		background: var(--surface-elevated);
		color: var(--text-soft);
		font-size: var(--text-sm);
		font-weight: var(--weight-medium);
		cursor: pointer;
	}

	.chip:hover {
		background: var(--surface-muted);
	}

	.chip[aria-pressed='true'] {
		border-color: var(--brand);
		background: var(--brand-tint);
		color: var(--brand);
	}
</style>

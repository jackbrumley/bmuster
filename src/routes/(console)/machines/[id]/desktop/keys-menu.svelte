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
	 * The Keys menu (SPEC-DESKTOP-KEYS): one row of small pills for the
	 * everyday combinations the viewer's own system would catch, and More for
	 * the rest: the other shortcuts, a custom combination and Release all
	 * keys. Shown only for control sessions. `afterSend` gives the keyboard
	 * back to the screen.
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
	const everyday = $derived(shortcuts.filter((shortcut) => shortcut.everyday));
	const others = $derived(shortcuts.filter((shortcut) => !shortcut.everyday));

	let more = $state(false);

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

{#snippet pill(shortcut: Shortcut)}
	<button
		data-raw-button="chip"
		type="button"
		class="chip"
		title={shortcut.hint}
		aria-label="{shortcut.label}, {shortcut.hint}"
		onclick={() => void run(shortcut)}>{shortcut.label}</button
	>
{/snippet}

<Panel heading={undefined} actions={undefined} tone="normal" padding="normal">
	<div class="row" role="group" aria-label="Keys">
		{#each everyday as shortcut (shortcut.id)}
			{@render pill(shortcut)}
		{/each}
		<button
			data-raw-button="chip"
			type="button"
			class="chip more"
			aria-expanded={more}
			aria-controls="{uid}-more"
			onclick={() => (more = !more)}>{more ? 'Fewer' : 'More'}</button
		>
	</div>

	{#if more}
		<div class="extra" id="{uid}-more">
			{#if others.length > 0}
				<div class="row" role="group" aria-label="More shortcuts">
					{#each others as shortcut (shortcut.id)}
						{@render pill(shortcut)}
					{/each}
				</div>
			{/if}

			<div class="custom" role="group" aria-labelledby="{uid}-custom">
				<SectionHeading id="{uid}-custom" text="Custom combination" tone="normal" />
				<div class="row" role="group" aria-label="Modifiers">
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
				<div class="row">
					<button
						data-raw-button="key"
						type="button"
						class="chip"
						aria-pressed={listening}
						onclick={() => (listening = true)}
						onkeydown={onCaptureKey}
						onblur={() => (listening = false)}
						>{listening ? 'Press a key now…' : 'Press a key'}</button
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

			<div>
				<Button
					variant="secondary"
					size="compact"
					type="button"
					onclick={() => {
						sendAll([{ type: 'release-all' }]);
					}}>Release all keys</Button
				>
			</div>
		</div>
	{/if}
</Panel>

<style>
	.row {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-2);
	}

	.hint {
		color: var(--muted);
		font-size: var(--text-xs);
	}

	.extra,
	.custom {
		display: grid;
		gap: var(--space-3);
	}

	.chip {
		min-width: 40px;
		min-height: 40px;
		padding: 0 var(--space-3);
		border: 1px solid var(--border);
		border-radius: var(--radius-pill);
		background: var(--surface-elevated);
		color: var(--text);
		font-size: var(--text-sm);
		font-weight: var(--weight-medium);
		white-space: nowrap;
		cursor: pointer;
	}

	.chip:hover {
		background: var(--surface-muted);
	}

	.chip.more {
		color: var(--brand);
	}

	.chip[aria-pressed='true'] {
		border-color: var(--brand);
		background: var(--brand-tint);
		color: var(--brand);
	}
</style>

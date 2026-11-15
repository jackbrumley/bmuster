<script lang="ts">
	import {
		IconClipboardCheck,
		IconClipboardText,
		IconCopy,
		IconDownload,
		IconFiles,
		IconUpload
	} from '@tabler/icons-svelte-runes';
	import { MediaQuery } from 'svelte/reactivity';
	import Button from '#lib/ui/button.svelte';
	import Checkbox from '#lib/ui/checkbox.svelte';
	import Panel from '#lib/ui/panel.svelte';
	import RadarSpinner from '#lib/ui/radar-spinner.svelte';
	import SectionHeading from '#lib/ui/section-heading.svelte';
	import TextField from '#lib/ui/text-field.svelte';
	import type { DesktopClipboard } from './clipboard.svelte.ts';
	import { PHONE_QUERY } from './pop-out.ts';

	/**
	 * Copy and paste with the machine (SPEC-DESKTOP 21). Shown only in a
	 * control session. Clipboard sharing (21.11) does most of it by itself:
	 * the switch turns it off and on. On a phone, which never lets a page read
	 * its clipboard, the panel explains the keyboard's paste and offers the
	 * machine's latest copy; on a desktop it offers Allow clipboard sharing
	 * once, and the text box with its buttons as the fallback.
	 */
	let {
		clipboard,
		getCopied
	}: {
		clipboard: DesktopClipboard;
		/** Get copied files, while sharing is off (SPEC-SESSION-FILES question 8); undefined without files. */
		getCopied: (() => void) | undefined;
	} = $props();

	const phone = new MediaQuery(PHONE_QUERY);
	const uid = $props.id();
	/** The machine's latest copy, cut short for the preview. */
	const preview = $derived(
		clipboard.latest.length > 200 ? `${clipboard.latest.slice(0, 200)}…` : clipboard.latest
	);
</script>

<Panel heading="Clipboard" actions={undefined} tone="normal" padding="normal">
	<div class="clipboard">
		<Checkbox label="Share clipboard" error={undefined} bind:checked={clipboard.sharing} />
		{#if phone.current}
			<SectionHeading id="{uid}-to-machine" text="To paste on the machine" tone="normal" />
			<p class="help">
				Copy on your phone, open the keyboard (Keys tab), then tap your keyboard's clipboard
				suggestion or long-press and choose Paste. It goes to the machine's clipboard — then paste
				there (right-click → Paste, or Ctrl+V).
			</p>
			<SectionHeading id="{uid}-from-machine" text="Copied on the machine" tone="normal" />
			<p class="help">
				{clipboard.sharing
					? 'Arrives on your phone automatically.'
					: 'Turn on Share clipboard to have it arrive on your phone.'}
			</p>
			{#if clipboard.latest !== ''}
				<p class="preview" aria-label="Latest from the machine">{preview}</p>
				<div class="actions">
					<Button
						variant="secondary"
						size="compact"
						type="button"
						onclick={() => {
							clipboard.text = clipboard.latest;
							void clipboard.copyToDevice();
						}}
					>
						<IconCopy size={18} /> Copy to phone
					</Button>
				</div>
			{/if}
		{:else}
			<SectionHeading id="{uid}-paste" text="To paste on the machine" tone="normal" />
			<p class="help">
				{clipboard.sharing
					? 'Click the screen and press Ctrl+V (on a Mac controlling a Mac, Cmd+V): what you copied here pastes where the cursor is. Works in every browser. Right-click → Paste on the machine pastes only what was last copied on the machine.'
					: 'Turn on Share clipboard to have Ctrl+V on the screen paste what you copied here.'}
			</p>
			{#if clipboard.sharing && !clipboard.readAllowed}
				<div class="actions">
					<Button
						variant="primary"
						size="compact"
						type="button"
						onclick={() => void clipboard.allowSharing()}
					>
						<IconClipboardCheck size={18} /> Allow clipboard sharing
					</Button>
				</div>
				<p class="help">
					Optional, in Chrome and Edge: also sends what you copy here to the machine each time you
					come back to this window, so right-click → Paste there has it too. Copies on the machine
					arrive here by themselves.
				</p>
			{/if}
			<TextField
				label="Text"
				name="clipboard"
				type="multiline"
				autocomplete="off"
				autocapitalize="off"
				required={false}
				error={clipboard.fieldError}
				bind:value={clipboard.text}
			/>
			<div class="actions">
				<Button
					variant="secondary"
					size="compact"
					type="button"
					onclick={() => {
						clipboard.pull();
					}}
				>
					{#if clipboard.waiting === 'pull'}
						<RadarSpinner size="small" />
					{:else}
						<IconDownload size={18} />
					{/if}
					Get from machine
				</Button>
				<Button
					variant="primary"
					size="compact"
					type="button"
					onclick={() => {
						clipboard.push();
					}}
				>
					{#if clipboard.waiting === 'push'}
						<RadarSpinner size="small" />
					{:else}
						<IconUpload size={18} />
					{/if}
					Send to machine
				</Button>
				<Button
					variant="secondary"
					size="compact"
					type="button"
					onclick={() => void clipboard.copyToDevice()}
				>
					<IconCopy size={18} /> Copy
				</Button>
				<Button
					variant="secondary"
					size="compact"
					type="button"
					onclick={() => void clipboard.pasteFromDevice()}
				>
					<IconClipboardText size={18} /> Paste from this device
				</Button>
			</div>
		{/if}
		{#if getCopied !== undefined && !clipboard.sharing}
			<div class="actions">
				<Button variant="secondary" size="compact" type="button" onclick={getCopied}>
					<IconFiles size={18} /> Get copied files
				</Button>
			</div>
		{/if}
		{#if clipboard.note.kind !== 'none'}
			<p
				class="note"
				class:error={clipboard.note.kind === 'error'}
				role={clipboard.note.kind === 'error' ? 'alert' : 'status'}
			>
				{clipboard.note.message}
			</p>
		{/if}
	</div>
</Panel>

<style>
	.clipboard {
		display: grid;
		gap: var(--space-3);
	}

	.actions {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-2);
	}

	.help,
	.note {
		margin: 0;
		color: var(--text-soft);
		font-size: var(--text-sm);
	}

	.preview {
		margin: 0;
		padding: var(--space-2) var(--space-3);
		border-radius: var(--radius-inner);
		background: var(--surface-muted);
		color: var(--text);
		font-size: var(--text-sm);
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}

	.note.error {
		color: var(--danger);
	}
</style>

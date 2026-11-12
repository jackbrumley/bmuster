<script lang="ts">
	import {
		IconClipboardText,
		IconCopy,
		IconDownload,
		IconUpload
	} from '@tabler/icons-svelte-runes';
	import Button from '#lib/ui/button.svelte';
	import Panel from '#lib/ui/panel.svelte';
	import RadarSpinner from '#lib/ui/radar-spinner.svelte';
	import TextField from '#lib/ui/text-field.svelte';
	import type { DesktopClipboard } from './clipboard.svelte.ts';

	/**
	 * Copy and paste with the machine (SPEC-DESKTOP 21): one text box, filled
	 * from the machine's clipboard or this device's, and sent to either. Text
	 * only, at most 1 MB. Shown only in a control session.
	 */
	let { clipboard }: { clipboard: DesktopClipboard } = $props();
</script>

<Panel heading="Clipboard" actions={undefined} tone="normal" padding="normal">
	<div class="clipboard">
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

	.note {
		margin: 0;
		color: var(--text-soft);
		font-size: var(--text-sm);
	}

	.note.error {
		color: var(--danger);
	}
</style>

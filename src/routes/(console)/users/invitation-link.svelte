<script lang="ts">
	import Button from '#lib/ui/button.svelte';
	import CopyField from '#lib/ui/copy-field.svelte';
	import Modal from '#lib/ui/modal.svelte';

	/**
	 * The invitation link to pass on, while email is not set up (SPEC-EMAIL
	 * E5). It is shown once; a new one can be made from the person's record.
	 */
	let {
		link,
		onclose
	}: {
		link: { kind: 'closed' } | { kind: 'open'; name: string; url: string; expiresIso: string };
		onclose: () => void;
	} = $props();
</script>

<Modal open={link.kind === 'open'} title="Invitation link" {onclose}>
	{#if link.kind === 'open'}
		<p class="intro">
			Send this link to {link.name} yourself. It lets them choose a password once, until
			{new Date(link.expiresIso).toLocaleString()}. Anyone with the link can use it, so send it only
			to them.
		</p>
		<CopyField value={link.url} label="Invitation link" />
		<p class="hint">Set up email in Settings → Email and invitations are sent for you.</p>
	{/if}
	{#snippet footer()}
		<Button variant="primary" size="compact" type="button" onclick={onclose}>Done</Button>
	{/snippet}
</Modal>

<style>
	.intro {
		font-size: var(--text-sm);
	}

	.hint {
		color: var(--muted);
		font-size: var(--text-xs);
	}
</style>

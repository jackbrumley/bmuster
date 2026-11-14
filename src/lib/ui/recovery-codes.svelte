<script lang="ts">
	import { IconCopy, IconDownload } from '@tabler/icons-svelte-runes';
	import { recoveryCodesText } from '#lib/domain/auth/two-factor.ts';
	import { copyText } from '#lib/utils/clipboard.ts';
	import Button from './button.svelte';
	import Notice from './notice.svelte';
	import { showToast } from './toast.svelte.ts';

	/**
	 * A new set of recovery codes, shown once (SPEC-TWO-FACTOR 2.6): Copy, and Download as
	 * `bmuster-recovery-codes.txt`. Used on the Account page and at sign-in.
	 */
	let { codes, email, origin }: { codes: readonly string[]; email: string; origin: string } =
		$props();

	const text = $derived(recoveryCodesText(codes, email, origin));

	async function copy(): Promise<void> {
		const result = await copyText(text);
		showToast(
			result.ok
				? 'Recovery codes copied.'
				: `This browser did not allow copying (${result.reason}).`,
			result.ok ? 'success' : 'error'
		);
	}

	function download(): void {
		const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
		const link = document.createElement('a');
		link.href = url;
		link.download = 'bmuster-recovery-codes.txt';
		link.click();
		URL.revokeObjectURL(url);
	}
</script>

<div class="codes">
	<Notice tone="warning" title="Save these recovery codes now">
		They are shown only this once. Each one signs you in once if you lose your phone. Keep them
		somewhere safe, away from your phone.
	</Notice>
	<ol class="list" aria-label="Recovery codes">
		{#each codes as code (code)}
			<li><code>{code}</code></li>
		{/each}
	</ol>
	<div class="actions">
		<Button variant="secondary" size="compact" type="button" onclick={() => void copy()}>
			<IconCopy size={18} /> Copy
		</Button>
		<Button variant="secondary" size="compact" type="button" onclick={download}>
			<IconDownload size={18} /> Download
		</Button>
	</div>
</div>

<style>
	.codes {
		display: grid;
		gap: var(--space-4);
	}

	.list {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(12rem, 1fr));
		gap: var(--space-2) var(--space-4);
		padding: var(--space-3);
		border-radius: var(--radius-inner);
		background: var(--surface-muted);
		list-style: none;
	}

	code {
		font-family: var(--font-mono);
		font-size: var(--text-sm);
	}

	.actions {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-2);
	}
</style>

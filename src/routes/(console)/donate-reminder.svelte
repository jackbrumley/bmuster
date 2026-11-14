<script lang="ts">
	import { resolve } from '$app/paths';
	import { IconHeart } from '@tabler/icons-svelte-runes';
	import {
		DONATE_URL,
		type DonateChoice,
		type DonateWording
	} from '#lib/domain/settings/donate-reminder.ts';
	import { donateAnswerReplySchema } from '#lib/schemas/settings/donate-reminder.ts';
	import Button from '#lib/ui/button.svelte';
	import RadarSpinner from '#lib/ui/radar-spinner.svelte';
	import { showToast } from '#lib/ui/toast.svelte.ts';
	import { apiRequest } from '#lib/utils/api-client.ts';

	/**
	 * The donation reminder (SPEC-DONATE): one slim line at the bottom of the
	 * Machines page, in the page flow, for admins. Donate is only a link; the
	 * console sends nothing about donations except the admin's own answer.
	 */
	let { wording }: { wording: DonateWording } = $props();

	const THANKS = 'Thanks for supporting BMuster. Still finding it useful?';
	const ASK =
		'BMuster is free and made by one person. If it saves you time, please consider a small donation.';
	const BUSINESS = 'If BMuster supports your business, please consider giving back.';

	const lines = $derived.by((): string[] => {
		switch (wording) {
			case 'first':
				return [ASK];
			case 'again':
				return [ASK, BUSINESS];
			case 'thanks':
				return [THANKS, ASK];
		}
	});

	let progress = $state<
		{ kind: 'open' } | { kind: 'sending'; choice: DonateChoice } | { kind: 'done' }
	>({ kind: 'open' });

	async function answer(choice: DonateChoice): Promise<void> {
		if (progress.kind !== 'open') return;
		progress = { kind: 'sending', choice };
		const result = await apiRequest({
			method: 'POST',
			url: resolve('/api/settings/donate-reminder'),
			body: { answer: choice },
			reply: donateAnswerReplySchema
		});
		if (result.ok) {
			progress = { kind: 'done' };
		} else {
			progress = { kind: 'open' };
			showToast(result.message, 'error');
		}
	}
</script>

{#snippet label(choice: DonateChoice, text: string)}
	{#if progress.kind === 'sending' && progress.choice === choice}<RadarSpinner size="small" />{/if}
	{text}
{/snippet}

{#if progress.kind !== 'done'}
	<aside class="donate" aria-label="Support BMuster">
		<p class="words">
			{#each lines as line (line)}
				<span>{line}</span>
			{/each}
		</p>
		<div class="actions">
			<a class="donate-link" href={DONATE_URL} target="_blank" rel="external noopener noreferrer">
				<IconHeart size={16} />
				Donate
			</a>
			<Button
				variant="secondary"
				size="compact"
				type="button"
				onclick={() => void answer('donated')}
			>
				{@render label('donated', "I've donated, thank you")}
			</Button>
			<Button
				variant="secondary"
				size="compact"
				type="button"
				onclick={() => void answer('not-now')}
			>
				{@render label('not-now', 'Not now')}
			</Button>
		</div>
	</aside>
{/if}

<style>
	.donate {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-3);
		padding-top: var(--space-4);
		border-top: 1px solid var(--border);
		color: var(--muted);
		font-size: var(--text-sm);
	}

	.words {
		display: grid;
		flex: 1 1 280px;
		gap: var(--space-1);
		min-width: 0;
		margin: 0;
	}

	.actions {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-2);
	}

	.donate-link {
		display: inline-flex;
		align-items: center;
		gap: var(--space-2);
		min-height: 40px;
		padding: var(--space-2) var(--space-4);
		border: 1px solid var(--brand);
		border-radius: var(--radius-pill);
		color: var(--brand);
		font-weight: var(--weight-semibold);
		text-decoration: none;
	}

	.donate-link:hover {
		background: var(--brand-tint);
	}
</style>

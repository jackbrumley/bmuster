<script lang="ts">
	import { IconAlertTriangle, IconCircleCheck, IconClockHour4 } from '@tabler/icons-svelte-runes';
	import ListCard from '#lib/ui/list-card.svelte';
	import ListRow from '#lib/ui/list-row.svelte';
	import { formatRelative } from '#lib/utils/format.ts';
	import { emailKindLabel, type EmailMessageView } from '#lib/domain/email/email-message.ts';

	/**
	 * The newest emails (SPEC-EMAIL E3, E8): sent, waiting to be retried and
	 * given up, with the server's reply or the error. Bodies are never kept.
	 */
	let { emails, now }: { emails: EmailMessageView[]; now: number } = $props();

	const MAX_TRIES = 8;

	function summary(email: EmailMessageView): string {
		switch (email.status.kind) {
			case 'sent':
				return `Sent ${formatRelative(email.status.atIso, now)} · ${email.status.reply}`;
			case 'queued':
				return email.status.attempts === 0
					? 'Waiting to be sent'
					: `Try ${email.status.attempts} of ${MAX_TRIES} failed; next try at ${new Date(email.status.nextAttemptIso).toLocaleTimeString()} · ${email.status.lastError ?? ''}`;
			case 'failed':
				return `Gave up after ${email.status.attempts} tries · ${email.status.error}`;
		}
	}
</script>

{#snippet emailRow(email: EmailMessageView)}
	<ListRow action={{ kind: 'static' }} align="start" dimmed={false}>
		<span class="icon {email.status.kind}">
			{#if email.status.kind === 'sent'}
				<IconCircleCheck size={20} />
			{:else if email.status.kind === 'queued'}
				<IconClockHour4 size={20} />
			{:else}
				<IconAlertTriangle size={20} />
			{/if}
		</span>
		<span class="body">
			<span class="subject">{email.subject}</span>
			<span class="meta">{email.to} · {emailKindLabel(email.kind)}</span>
			<span class="detail {email.status.kind}">{summary(email)}</span>
		</span>
		<span class="when">{formatRelative(email.createdIso, now)}</span>
	</ListRow>
{/snippet}

<ListCard
	heading="Recent emails"
	actions={undefined}
	label="Recent emails, newest first"
	items={emails}
	key={(email: EmailMessageView) => email.id}
	row={emailRow}
	empty="No emails yet."
/>

<style>
	.icon {
		display: inline-flex;
		flex-shrink: 0;
		padding-top: var(--space-0-5);
	}

	.icon.sent {
		color: var(--success);
	}

	.icon.queued {
		color: var(--warning);
	}

	.icon.failed {
		color: var(--danger);
	}

	.body {
		display: grid;
		flex: 1;
		gap: var(--space-0-5);
		min-width: 0;
	}

	.subject {
		font-weight: var(--weight-semibold);
	}

	.meta,
	.when {
		color: var(--muted);
		font-size: var(--text-xs);
	}

	.detail {
		color: var(--text-soft);
		font-size: var(--text-xs);
		overflow-wrap: anywhere;
	}

	.detail.failed {
		color: var(--danger);
	}

	.when {
		flex-shrink: 0;
	}
</style>

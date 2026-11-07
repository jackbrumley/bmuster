<script lang="ts">
	import { refreshAll } from '$app/navigation';
	import { IconAlertTriangle, IconCircleCheck, IconSend } from '@tabler/icons-svelte-runes';
	import Button from '#lib/ui/button.svelte';
	import Panel from '#lib/ui/panel.svelte';
	import TextField from '#lib/ui/text-field.svelte';
	import { apiRequest } from '#lib/utils/api-client.ts';
	import { testEmailReplySchema, testEmailRequestSchema } from '#lib/schemas/email/email.ts';
	import type { SendResult } from '#lib/domain/email/email-message.ts';

	/**
	 * Send a test email with the saved settings (SPEC-EMAIL E2): straight
	 * away, showing the server's reply or the exact error.
	 */
	let { defaultTo }: { defaultTo: string } = $props();

	let to = $state('');
	let touched = $state(false);
	let busy = $state(false);
	let fieldError = $state<string | undefined>(undefined);
	let result = $state<{ kind: 'none' } | SendResult>({ kind: 'none' });

	const address = $derived(touched ? to : defaultTo);

	async function send(): Promise<void> {
		const parsed = testEmailRequestSchema.safeParse({ to: address });
		if (!parsed.success) {
			fieldError = parsed.error.issues[0]?.message;
			return;
		}
		fieldError = undefined;
		busy = true;
		const reply = await apiRequest({
			method: 'POST',
			url: '/api/email/test',
			body: parsed.data,
			reply: testEmailReplySchema
		});
		busy = false;
		result = reply.ok ? reply.data.result : { kind: 'failed', error: reply.message };
		await refreshAll();
	}
</script>

<Panel heading="Send a test email" actions={undefined} tone="normal" padding="normal">
	<p class="intro">
		Uses the saved settings, even while sending is off, so you can try them first.
	</p>
	<TextField
		label="Send to"
		name="testTo"
		type="email"
		autocomplete="email"
		autocapitalize="off"
		required={true}
		error={fieldError}
		bind:value={
			() => address,
			(typed: string) => {
				touched = true;
				to = typed;
			}
		}
	/>
	<div class="actions">
		<Button variant="secondary" size="compact" type="button" onclick={() => void send()}>
			<IconSend size={18} />
			{busy ? 'Sending…' : 'Send a test email'}
		</Button>
	</div>
	{#if result.kind === 'sent'}
		<p class="result ok" role="status">
			<IconCircleCheck size={18} />
			<span><strong>Sent.</strong> {result.reply}</span>
		</p>
	{:else if result.kind === 'failed'}
		<p class="result failed" role="alert">
			<IconAlertTriangle size={18} />
			<span><strong>Not sent.</strong> {result.error}</span>
		</p>
	{/if}
</Panel>

<style>
	.intro {
		color: var(--muted);
		font-size: var(--text-sm);
	}

	.actions {
		display: flex;
		justify-content: flex-end;
	}

	.result {
		display: flex;
		align-items: flex-start;
		gap: var(--space-2);
		padding: var(--space-3);
		border-radius: var(--radius-control);
		font-size: var(--text-sm);
		overflow-wrap: anywhere;
	}

	.ok {
		background: var(--success-bg);
		color: var(--success);
	}

	.failed {
		background: var(--danger-bg);
		color: var(--danger);
	}
</style>

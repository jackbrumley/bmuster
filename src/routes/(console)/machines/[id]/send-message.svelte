<script lang="ts">
	import { IconMessage } from '@tabler/icons-svelte-runes';
	import type { Machine } from '#lib/domain/machines/machine.ts';
	import {
		userMessageReplySchema,
		userMessageRequestSchema
	} from '#lib/schemas/machines/user-message.ts';
	import Button from '#lib/ui/button.svelte';
	import Modal from '#lib/ui/modal.svelte';
	import TextField from '#lib/ui/text-field.svelte';
	import { showToast } from '#lib/ui/toast.svelte.ts';
	import { apiRequest } from '#lib/utils/api-client.ts';

	/**
	 * Send message: a message box on the machine's screen, for whoever sits
	 * there (`#lib/domain/machines/user-message.ts`). The page shows this only
	 * to people who may send one, on Windows machines.
	 */
	let { machine }: { machine: Machine } = $props();

	let open = $state(false);
	let text = $state('');
	let problem = $state<string | undefined>(undefined);
	let sending = $state(false);

	function start(): void {
		text = '';
		problem = undefined;
		open = true;
	}

	async function send(): Promise<void> {
		if (sending) {
			return;
		}
		const checked = userMessageRequestSchema.safeParse({ text });
		if (!checked.success) {
			problem = checked.error.issues[0]?.message;
			return;
		}
		sending = true;
		const result = await apiRequest({
			method: 'POST',
			url: `/api/machines/${machine.id}/message`,
			body: checked.data,
			reply: userMessageReplySchema
		});
		sending = false;
		if (!result.ok) {
			problem = result.message;
			return;
		}
		open = false;
		showToast(`Message shown on ${machine.name}.`, 'success');
	}
</script>

<Button variant="secondary" size="compact" type="button" onclick={start}>
	<IconMessage size={18} /> Send message
</Button>

<Modal {open} title="Send a message to {machine.name}" onclose={() => (open = false)}>
	<div class="fields">
		<p class="hint">
			It pops up on the screen of whoever is signed in, with your name. It is kept in Activity.
		</p>
		<TextField
			label="Message"
			name="message"
			type="multiline"
			autocomplete="off"
			autocapitalize="sentences"
			required={true}
			error={problem}
			bind:value={text}
		/>
	</div>
	{#snippet footer()}
		<Button variant="secondary" size="compact" type="button" onclick={() => (open = false)}
			>Cancel</Button
		>
		<Button
			variant="primary"
			size="compact"
			type="button"
			onclick={() => {
				void send();
			}}>Send</Button
		>
	{/snippet}
</Modal>

<style>
	.fields {
		display: grid;
		gap: var(--space-3);
	}

	.hint {
		margin: 0;
		color: var(--muted);
		font-size: var(--text-sm);
	}
</style>

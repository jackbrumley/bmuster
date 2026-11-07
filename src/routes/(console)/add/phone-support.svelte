<script lang="ts">
	import { resolve } from '$app/paths';
	import { IconPhone, IconPhoneOff } from '@tabler/icons-svelte-runes';
	import { formatSupportCode, SUPPORT_CODE_MINUTES } from '#lib/domain/machines/phone-support.ts';
	import {
		cancelSupportCodeReplySchema,
		createSupportCodeReplySchema
	} from '#lib/schemas/machines/support-codes.ts';
	import Button from '#lib/ui/button.svelte';
	import { confirmAction } from '#lib/ui/confirm-action.svelte.ts';
	import Panel from '#lib/ui/panel.svelte';
	import { showToast } from '#lib/ui/toast.svelte.ts';
	import { apiRequest } from '#lib/utils/api-client.ts';
	import JoinCodeStatus from './join-code-status.svelte';

	/**
	 * Phone support on Add machine (SPEC-JOIN J12): a 6-digit support code
	 * and the address to read out, both large; the live status of the join
	 * code behind it; Cancel. It carries the machine groups picked above.
	 */
	let {
		origin,
		machineGroupIds
	}: {
		/** This server's address, as the caller will reach it. */
		origin: string;
		machineGroupIds: readonly string[];
	} = $props();

	type Support =
		| { kind: 'idle' }
		| { kind: 'making' }
		| { kind: 'active'; id: string; code: string; expiresAtIso: string; joinCodeId: string }
		| { kind: 'failed'; message: string };

	let support = $state<Support>({ kind: 'idle' });

	/** What to read out: the address without https://. */
	const address = $derived(`${new URL(origin).host}${resolve('/join')}`);

	async function start(): Promise<void> {
		support = { kind: 'making' };
		const result = await apiRequest({
			method: 'POST',
			url: '/api/support-codes',
			body: { machineGroupIds },
			reply: createSupportCodeReplySchema
		});
		support = result.ok
			? {
					kind: 'active',
					id: result.data.id,
					code: result.data.code,
					expiresAtIso: result.data.expiresAtIso,
					joinCodeId: result.data.joinCodeId
				}
			: { kind: 'failed', message: result.message };
	}

	async function cancel(id: string): Promise<void> {
		const yes = await confirmAction({
			title: 'Cancel this support code?',
			message: 'The code stops working straight away, even if the caller is part way through.',
			confirmLabel: 'Cancel code'
		});
		if (!yes) {
			return;
		}
		const result = await apiRequest({
			method: 'DELETE',
			url: `/api/support-codes/${id}`,
			body: undefined,
			reply: cancelSupportCodeReplySchema
		});
		showToast(
			result.ok ? 'Support code cancelled.' : result.message,
			result.ok ? 'success' : 'error'
		);
		if (result.ok) {
			support = { kind: 'idle' };
		}
	}

	function expiryTime(iso: string): string {
		return new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
	}
</script>

<Panel heading="Phone support" actions={undefined} tone="normal" padding="normal">
	{#if support.kind === 'active'}
		<div class="read-out">
			<p class="label">Ask them to go to</p>
			<p class="address">{address}</p>
			<p class="label">and type the support code</p>
			<p class="code" aria-label="Support code">{formatSupportCode(support.code)}</p>
			<p class="hint">Works once. Expires at {expiryTime(support.expiresAtIso)}.</p>
		</div>
		<JoinCodeStatus
			codeId={support.joinCodeId}
			mode={{
				kind: 'single',
				onNewCode: () => {
					void start();
				}
			}}
		/>
		<div class="actions">
			<Button
				variant="secondary"
				size="compact"
				type="button"
				onclick={() => {
					if (support.kind === 'active') {
						void cancel(support.id);
					}
				}}
			>
				<IconPhoneOff size={18} /> Cancel code
			</Button>
		</div>
	{:else}
		<p class="intro">
			Helping someone over the phone? Give them a short code to type at <strong>{address}</strong>.
			It works once, for {SUPPORT_CODE_MINUTES} minutes, and warns them about scams before showing the
			install command.
		</p>
		{#if support.kind === 'failed'}
			<p class="error">{support.message}</p>
		{/if}
		<div class="actions">
			<Button
				variant="primary"
				size="compact"
				type="button"
				onclick={() => {
					if (support.kind !== 'making') {
						void start();
					}
				}}
			>
				<IconPhone size={18} />
				{support.kind === 'making' ? 'Starting…' : 'Start phone support'}
			</Button>
		</div>
	{/if}
</Panel>

<style>
	.read-out {
		display: grid;
		gap: var(--space-1);
		text-align: center;
	}

	.label {
		color: var(--muted);
		font-size: var(--text-sm);
	}

	.address {
		font-size: var(--text-xl);
		font-weight: var(--weight-semibold);
		overflow-wrap: anywhere;
	}

	.code {
		font-family: var(--font-mono);
		font-size: var(--text-2xl);
		font-weight: var(--weight-bold);
		letter-spacing: var(--tracking-caps);
	}

	.hint {
		color: var(--muted);
		font-size: var(--text-xs);
	}

	.intro {
		color: var(--text-soft);
		font-size: var(--text-sm);
	}

	.error {
		color: var(--danger);
		font-size: var(--text-sm);
	}

	.actions {
		display: flex;
		justify-content: flex-end;
	}
</style>

<script lang="ts">
	import { resolve } from '$app/paths';
	import { IconLink, IconX } from '@tabler/icons-svelte-runes';
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
	import MachineGroupPicker from './machine-group-picker.svelte';

	/**
	 * Enrolment codes on Add machine (SPEC-JOIN J12): a 6-digit one-time code
	 * and the address to give the person at the computer, both large; the live status of the join
	 * code behind it; Cancel. It carries the machine groups picked above.
	 */
	let {
		origin,
		machineGroupIds,
		machineGroups,
		onMachineGroupsChange
	}: {
		/** This server's address, as the person at the computer will reach it. */
		origin: string;
		machineGroupIds: readonly string[];
		machineGroups: { id: string; name: string }[];
		onMachineGroupsChange: (ids: string[]) => void;
	} = $props();

	type Support =
		| { kind: 'idle' }
		| { kind: 'making' }
		| { kind: 'active'; id: string; code: string; expiresAtIso: string; joinCodeId: string }
		| { kind: 'failed'; message: string };

	let support = $state<Support>({ kind: 'idle' });

	/** What to give out: the address without https://. */
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
			title: 'Cancel this enrolment code?',
			message:
				'The code stops working straight away, even if someone is part way through enrolling.',
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
			result.ok ? 'Enrolment code cancelled.' : result.message,
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

<Panel heading="Enrolment code" actions={undefined} tone="normal" padding="normal">
	<MachineGroupPicker
		groups={machineGroups}
		selected={machineGroupIds}
		onchange={onMachineGroupsChange}
	/>
	{#if support.kind === 'active'}
		<div class="read-out">
			<p class="label">Give this code to the person at the computer. They go to</p>
			<p class="address">{address}</p>
			<p class="label">and enter the enrolment code</p>
			<p class="code" aria-label="Enrolment code">{formatSupportCode(support.code)}</p>
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
				<IconX size={18} /> Cancel code
			</Button>
		</div>
	{:else}
		<p class="intro">
			Give the person at the computer a short enrolment code; they enter it at
			<strong>{address}</strong> to enrol the computer. It works once, for {SUPPORT_CODE_MINUTES} minutes,
			and the page shows a scam warning before the install command.
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
				<IconLink size={18} />
				{support.kind === 'making' ? 'Creating code…' : 'Create enrolment code'}
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

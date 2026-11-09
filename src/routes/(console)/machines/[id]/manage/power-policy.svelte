<script lang="ts">
	import { refreshAll } from '$app/navigation';
	import { IconBatteryCharging } from '@tabler/icons-svelte-runes';
	import { powerLine, type PowerReport } from '#lib/domain/machines/power.ts';
	import { powerPolicyReplySchema } from '#lib/schemas/machines/power-policy.ts';
	import Panel from '#lib/ui/panel.svelte';
	import SegmentedControl from '#lib/ui/segmented-control.svelte';
	import { showToast } from '#lib/ui/toast.svelte.ts';
	import { apiRequest } from '#lib/utils/api-client.ts';

	/**
	 * Manage → Power (SPEC-STAY-AWAKE): Stay awake on mains power, and what the agent reports
	 * doing about it. Admins only (the Manage tab is); every change is audited by the server.
	 */
	let {
		machineId,
		machineName,
		keepAwakeOnAc,
		power
	}: {
		machineId: string;
		machineName: string;
		keepAwakeOnAc: boolean;
		/** `pending` until the machine's first inventory arrives. */
		power: PowerReport | { kind: 'pending' };
	} = $props();

	const ON_OFF = [
		{ value: 'on', label: 'On' },
		{ value: 'off', label: 'Off' }
	] as const;

	let saving = $state(false);

	const line = $derived(
		power.kind === 'pending'
			? { text: 'The machine has not reported its power source yet.', tone: 'normal' as const }
			: powerLine(power, keepAwakeOnAc)
	);

	async function save(picked: 'on' | 'off'): Promise<void> {
		const on = picked === 'on';
		if (on === keepAwakeOnAc || saving) {
			return;
		}
		saving = true;
		const result = await apiRequest({
			method: 'PUT',
			url: `/api/machines/${machineId}/power-policy`,
			body: { keepAwakeOnAc: on },
			reply: powerPolicyReplySchema
		});
		saving = false;
		if (!result.ok) {
			showToast(result.message, 'error');
			return;
		}
		const when = result.data.delivered
			? 'now'
			: 'when it is back online (it is offline at the moment)';
		showToast(
			on
				? `${machineName} stays awake on mains power from ${when}.`
				: `${machineName} sleeps as it is set to again from ${when}.`,
			'success'
		);
		await refreshAll();
	}
</script>

<Panel heading="Power" actions={undefined} tone="normal" padding="normal">
	<SegmentedControl
		label="Stay awake on mains power"
		options={ON_OFF}
		bind:value={() => (keepAwakeOnAc ? 'on' : 'off'), (picked: 'on' | 'off') => void save(picked)}
	/>
	<p class="muted">
		While it is on mains power the machine does not go to sleep by itself, so it stays reachable. On
		battery it sleeps normally. Closing the lid, the power button and Sleep or Shut down still work,
		and the screen can still turn off.
	</p>
	<p class="line {line.tone}" role="status">
		<IconBatteryCharging size={18} aria-hidden="true" />
		<span>{line.text}</span>
	</p>
</Panel>

<style>
	.muted {
		color: var(--muted);
		font-size: var(--text-sm);
	}

	.line {
		display: flex;
		align-items: flex-start;
		gap: var(--space-2);
		font-size: var(--text-sm);
		overflow-wrap: anywhere;
	}

	.line span {
		min-width: 0;
	}

	.line.warning {
		color: var(--warning);
	}

	.line.danger {
		color: var(--danger);
	}
</style>

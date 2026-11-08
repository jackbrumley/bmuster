<script lang="ts">
	import { IconKey } from '@tabler/icons-svelte-runes';
	import { manualInstallCommand } from '#lib/domain/machines/agent-release.ts';
	import type { ServedPin } from '#lib/domain/settings/local-tls.ts';
	import Button from '#lib/ui/button.svelte';
	import CopyField from '#lib/ui/copy-field.svelte';
	import SegmentedControl from '#lib/ui/segmented-control.svelte';
	import JoinCodeStatus from './join-code-status.svelte';
	import MachineGroupPicker from './machine-group-picker.svelte';
	import { makeJoinCode, type CodeState } from './join-code.ts';

	/**
	 * For deployment tools (SPEC-INSTALL-OPTIONS M4): one download pushed to
	 * many machines, each running the same command with one roll-out code
	 * (up to 100 machines, up to 7 days; SPEC-ENROLMENT decision 13.2).
	 */
	let {
		os,
		origin,
		pin,
		machineGroups
	}: {
		os: 'linux' | 'windows';
		origin: string;
		pin: ServedPin;
		machineGroups: { id: string; name: string }[];
	} = $props();

	const useOptions = [
		{ value: '10', label: '10' },
		{ value: '25', label: '25' },
		{ value: '50', label: '50' },
		{ value: '100', label: '100' }
	] as const;
	const lifeOptions = [
		{ value: '60', label: '1 hour' },
		{ value: '1440', label: '1 day' },
		{ value: '10080', label: '7 days' }
	] as const;

	let uses = $state<(typeof useOptions)[number]['value']>('25');
	let minutes = $state<(typeof lifeOptions)[number]['value']>('1440');
	let rollout = $state<CodeState>({ kind: 'none' });
	let groupIds = $state<string[]>([]);

	async function makeRollout(): Promise<void> {
		rollout = { kind: 'making' };
		rollout = await makeJoinCode(Number(uses), Number(minutes), groupIds);
	}

	function expiry(iso: string): string {
		return new Date(iso).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
	}
</script>

<section class="rollout" aria-labelledby="rollout-heading">
	<h2 id="rollout-heading">For deployment tools</h2>
	<p class="hint">
		Intune, Group Policy or Ansible: push the one download to every machine and run the command
		above with a roll-out join code instead. One roll-out code works for up to 100 machines, for up
		to 7 days. Each machine still gets its own identity.
	</p>
	<SegmentedControl label="Machines" options={useOptions} bind:value={uses} />
	<SegmentedControl label="Valid for" options={lifeOptions} bind:value={minutes} />
	<MachineGroupPicker
		groups={machineGroups}
		selected={groupIds}
		onchange={(ids: string[]) => {
			groupIds = ids;
		}}
	/>
	<div>
		<Button
			variant="secondary"
			size="compact"
			type="button"
			onclick={() => {
				void makeRollout();
			}}
		>
			<IconKey size={18} />
			{rollout.kind === 'making' ? 'Making…' : 'Make a roll-out code'}
		</Button>
	</div>
	{#if rollout.kind === 'ready'}
		<div class="join-code">
			<p class="code">{rollout.code}</p>
			<p class="hint">
				Works for {rollout.maxUses} machines until {expiry(rollout.expiresAtIso)}.
			</p>
		</div>
		<JoinCodeStatus codeId={rollout.id} mode={{ kind: 'rollout' }} />
		<CopyField
			value={manualInstallCommand(os, origin, rollout.code, pin)}
			label="roll-out install command"
		/>
	{:else if rollout.kind === 'failed'}
		<p class="error">{rollout.message}</p>
	{/if}
</section>

<style>
	.rollout {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: var(--space-3);
		padding: var(--space-4);
		border-radius: var(--radius-inner);
		background: var(--surface-muted);
	}

	h2 {
		font-size: var(--text-sm);
		font-weight: var(--weight-semibold);
	}

	.hint {
		color: var(--muted);
		font-size: var(--text-xs);
	}

	.code {
		color: var(--text);
		font-family: var(--font-mono);
		font-size: var(--text-sm);
		font-weight: var(--weight-bold);
		letter-spacing: var(--tracking-caps);
		text-align: center;
	}

	.join-code {
		text-align: center;
	}

	.error {
		color: var(--danger);
		font-size: var(--text-sm);
	}
</style>

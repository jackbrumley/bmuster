<script lang="ts">
	import { resolve } from '$app/paths';
	import {
		CONSENTS,
		PERMISSIONS,
		permissionLabel,
		togglePermission,
		type Consent,
		type Permission
	} from '#lib/domain/access/access.ts';
	import Checkbox from '#lib/ui/checkbox.svelte';
	import SegmentedControl from '#lib/ui/segmented-control.svelte';

	/**
	 * The fields of a rule (SPEC-ACCESS A4): who, on what, what they may do
	 * and whether it asks first. Ticking a permission ticks what it includes
	 * (See inventory; Control desktop also ticks Watch desktop); unticking one
	 * unticks what needs it.
	 */
	type Named = { id: string; name: string };

	let {
		userGroups,
		machineGroups,
		userGroupId = $bindable(),
		machineGroupId = $bindable(),
		permissions = $bindable(),
		consent = $bindable(),
		error
	}: {
		userGroups: Named[];
		machineGroups: Named[];
		userGroupId: string | null;
		machineGroupId: string | null;
		permissions: Permission[];
		consent: Consent;
		error: string | undefined;
	} = $props();

	const consentOptions = CONSENTS.map((value) => ({
		value,
		label: value === 'unattended' ? 'Connect straight away' : 'Ask first'
	}));
</script>

{#snippet choices(
	label: string,
	groups: Named[],
	value: string | null,
	choose: (id: string) => void
)}
	<div class="field">
		<span class="label">{label}</span>
		{#if groups.length === 0}
			<p class="hint">
				No groups yet. <a href={resolve('/(console)/groups')}>Make one on the Groups page</a>.
			</p>
		{:else}
			<div class="chips" role="group" aria-label={label}>
				{#each groups as group (group.id)}
					<button
						data-raw-button="chip"
						type="button"
						class="chip"
						aria-pressed={value === group.id}
						onclick={() => {
							choose(group.id);
						}}
					>
						{group.name}
					</button>
				{/each}
			</div>
		{/if}
	</div>
{/snippet}

{@render choices('People in', userGroups, userGroupId, (id) => (userGroupId = id))}
{@render choices(
	'May use machines in',
	machineGroups,
	machineGroupId,
	(id) => (machineGroupId = id)
)}

<fieldset class="field">
	<legend class="label">Permissions</legend>
	{#each PERMISSIONS as permission (permission)}
		<Checkbox
			label={permissionLabel(permission)}
			error={undefined}
			bind:checked={
				() => permissions.includes(permission),
				(on: boolean) => {
					permissions = togglePermission(permissions, permission, on);
				}
			}
		/>
	{/each}
	<p class="hint">Every permission includes See inventory; Control desktop includes watching it.</p>
</fieldset>

<SegmentedControl label="Before connecting" options={consentOptions} bind:value={consent} />
<p class="hint">
	{consent === 'unattended'
		? 'Connects at once, for unattended access.'
		: 'The person at the screen is asked to allow it; with nobody signed in it connects at once.'}
</p>

{#if error !== undefined}<p class="problem" role="alert">{error}</p>{/if}

<style>
	.field {
		display: grid;
		gap: var(--space-2);
		min-width: 0;
		margin: 0;
		padding: 0;
		border: none;
	}

	.label {
		padding: 0;
		color: var(--text-soft);
		font-size: var(--text-sm);
		font-weight: var(--weight-medium);
	}

	.chips {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-2);
	}

	.chip {
		min-height: 40px;
		padding: var(--space-1) var(--space-3);
		border: 1px solid var(--border);
		border-radius: var(--radius-pill);
		background: var(--surface-elevated);
		color: var(--text-soft);
		font-size: var(--text-sm);
		overflow-wrap: anywhere;
		cursor: pointer;
	}

	.chip[aria-pressed='true'] {
		border-color: var(--brand);
		background: var(--brand-tint);
		color: var(--brand);
	}

	.hint {
		color: var(--muted);
		font-size: var(--text-xs);
	}

	a {
		color: var(--brand);
	}

	.problem {
		color: var(--danger);
		font-size: var(--text-sm);
	}
</style>

<script lang="ts">
	import { resolve } from '$app/paths';
	import {
		CONSENTS,
		PERMISSIONS,
		permissionAbout,
		permissionLabel,
		togglePermission,
		type Consent,
		type Permission
	} from '#lib/domain/access/access.ts';
	import Checkbox from '#lib/ui/checkbox.svelte';
	import SegmentedControl from '#lib/ui/segmented-control.svelte';

	/**
	 * The fields of a rule (SPEC-ACCESS A4): who, on what, what they may do
	 * and whether it asks first. Each permission has a line on what it allows
	 * (SPEC-MCP M40). Ticking a permission ticks what it includes (See
	 * inventory; Control desktop also ticks Watch desktop; AI commands also
	 * ticks AI can view); unticking one unticks what needs it.
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
	{#if groups.length === 0}
		<div class="field">
			<span class="label">{label}</span>
			<p class="hint">
				No groups yet. <a href={resolve('/(console)/groups')}>Make one on the Groups page</a>.
			</p>
		</div>
	{:else}
		<SegmentedControl
			{label}
			options={groups.map((group) => ({ value: group.id, label: group.name }))}
			bind:value={
				() => value,
				(picked: string | null) => {
					if (picked !== null) {
						choose(picked);
					}
				}
			}
		/>
	{/if}
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
		<div class="permission">
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
			<p class="about">{permissionAbout(permission)}</p>
		</div>
	{/each}
	<p class="hint">
		Every permission includes See inventory; Control desktop includes watching it; AI commands
		includes AI can view. Admins get the two AI permissions only from a rule.
	</p>
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

	.hint {
		color: var(--muted);
		font-size: var(--text-xs);
	}

	.permission {
		display: grid;
		min-width: 0;
	}

	/* Lines up under the label: the 20px box and its gap. */
	.about {
		padding-left: var(--space-8);
		color: var(--muted);
		font-size: var(--text-xs);
		overflow-wrap: anywhere;
	}

	a {
		color: var(--brand);
	}

	.problem {
		color: var(--danger);
		font-size: var(--text-sm);
	}
</style>

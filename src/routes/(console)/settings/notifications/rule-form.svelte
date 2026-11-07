<script lang="ts">
	import { resolve } from '$app/paths';
	import SegmentedControl from '#lib/ui/segmented-control.svelte';
	import TextField from '#lib/ui/text-field.svelte';
	import {
		NOTIFICATION_CATALOGUE,
		NOTIFICATION_EVENT_KINDS,
		type NotificationEventKind
	} from '#lib/domain/notifications/notifications.ts';
	import type { RuleDraft } from './rule-draft.ts';

	/**
	 * The fields of a notification rule (SPEC-EMAIL E6): which event, on which
	 * machines, to whom, and whether it is on.
	 */
	type Named = { id: string; name: string };

	let {
		draft = $bindable(),
		userGroups,
		machineGroups,
		machines,
		error
	}: {
		draft: RuleDraft;
		userGroups: Named[];
		machineGroups: Named[];
		machines: Named[];
		error: string | undefined;
	} = $props();

	const events = NOTIFICATION_EVENT_KINDS.map((kind) => ({
		value: kind,
		label: NOTIFICATION_CATALOGUE[kind].label
	}));

	const scopes: { value: RuleDraft['scopeKind']; label: string }[] = [
		{ value: 'any-machine', label: 'Any machine' },
		{ value: 'machine-group', label: 'A group of machines' },
		{ value: 'machine', label: 'One machine' }
	];

	const recipientKinds: { value: RuleDraft['recipientsKind']; label: string }[] = [
		{ value: 'addresses', label: 'Email addresses' },
		{ value: 'user-group', label: 'A group of people' }
	];

	const onOff: { value: 'on' | 'off'; label: string }[] = [
		{ value: 'on', label: 'On' },
		{ value: 'off', label: 'Off' }
	];

	function options(list: Named[]): { value: string; label: string }[] {
		return list.map((item) => ({ value: item.id, label: item.name }));
	}
</script>

{#snippet pick(
	label: string,
	list: Named[],
	value: string | null,
	choose: (id: string) => void,
	none: string
)}
	{#if list.length === 0}
		<div class="field">
			<span class="label">{label}</span>
			<p class="hint">{none}</p>
		</div>
	{:else}
		<SegmentedControl
			{label}
			options={options(list)}
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

<SegmentedControl
	label="When"
	options={events}
	bind:value={
		() => draft.eventKind,
		(picked: NotificationEventKind | null) => {
			if (picked !== null) {
				draft.eventKind = picked;
			}
		}
	}
/>
<p class="hint">{NOTIFICATION_CATALOGUE[draft.eventKind].description}</p>

<SegmentedControl
	label="On"
	options={scopes}
	bind:value={
		() => draft.scopeKind,
		(picked: RuleDraft['scopeKind'] | null) => {
			if (picked !== null) {
				draft.scopeKind = picked;
			}
		}
	}
/>
{#if draft.scopeKind === 'machine-group'}
	{@render pick(
		'Group of machines',
		machineGroups,
		draft.machineGroupId,
		(id) => (draft.machineGroupId = id),
		'No groups of machines yet.'
	)}
{:else if draft.scopeKind === 'machine'}
	{@render pick(
		'Machine',
		machines,
		draft.machineId,
		(id) => (draft.machineId = id),
		'No machines yet.'
	)}
{/if}

<SegmentedControl
	label="Tell"
	options={recipientKinds}
	bind:value={
		() => draft.recipientsKind,
		(picked: RuleDraft['recipientsKind'] | null) => {
			if (picked !== null) {
				draft.recipientsKind = picked;
			}
		}
	}
/>
{#if draft.recipientsKind === 'user-group'}
	{#if userGroups.length === 0}
		<p class="hint">
			No groups of people yet. <a href={resolve('/(console)/groups')}>Make one on the Groups page</a
			>.
		</p>
	{:else}
		{@render pick(
			'Group of people',
			userGroups,
			draft.userGroupId,
			(id) => (draft.userGroupId = id),
			''
		)}
	{/if}
{:else}
	<TextField
		label="Email addresses (one per line, or separated by commas)"
		name="addresses"
		type="multiline"
		autocomplete="off"
		autocapitalize="off"
		required={true}
		error={undefined}
		bind:value={draft.addresses}
	/>
{/if}

<SegmentedControl
	label="Rule is"
	options={onOff}
	bind:value={
		() => (draft.enabled ? 'on' : 'off'),
		(picked: 'on' | 'off' | null) => {
			draft.enabled = picked === 'on';
		}
	}
/>

{#if error !== undefined}<p class="problem" role="alert">{error}</p>{/if}

<style>
	.field {
		display: grid;
		gap: var(--space-2);
	}

	.label {
		color: var(--text-soft);
		font-size: var(--text-sm);
		font-weight: var(--weight-medium);
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

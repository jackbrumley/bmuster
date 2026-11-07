<script lang="ts">
	import { resolve } from '$app/paths';
	import Checkbox from '#lib/ui/checkbox.svelte';

	/**
	 * Which machine groups a join code puts its machines in (SPEC-ACCESS A7).
	 * All machines is left out: every machine is in it anyway.
	 */
	let {
		groups,
		selected,
		onchange
	}: {
		groups: { id: string; name: string }[];
		selected: readonly string[];
		onchange: (ids: string[]) => void;
	} = $props();

	function toggle(id: string, on: boolean): void {
		onchange(
			groups
				.map((group) => group.id)
				.filter((candidate) => (candidate === id ? on : selected.includes(candidate)))
		);
	}
</script>

<fieldset class="picker">
	<legend>Machine groups it joins</legend>
	{#if groups.length === 0}
		<p class="hint">
			No machine groups yet. It joins All machines;
			<a href={resolve('/(console)/groups')}>make a group</a> to give people access to it.
		</p>
	{:else}
		<div class="options">
			{#each groups as group (group.id)}
				<Checkbox
					label={group.name}
					error={undefined}
					bind:checked={
						() => selected.includes(group.id),
						(on: boolean) => {
							toggle(group.id, on);
						}
					}
				/>
			{/each}
		</div>
		<p class="hint">Every machine is also in All machines.</p>
	{/if}
</fieldset>

<style>
	.picker {
		display: grid;
		gap: var(--space-1);
		min-width: 0;
		margin: 0;
		padding: 0;
		border: none;
	}

	legend {
		margin-bottom: var(--space-1);
		padding: 0;
		color: var(--muted);
		font-size: var(--text-xs);
		font-weight: var(--weight-medium);
	}

	.options {
		display: flex;
		flex-wrap: wrap;
		gap: 0 var(--space-4);
	}

	.hint {
		color: var(--muted);
		font-size: var(--text-xs);
	}

	a {
		color: var(--brand);
	}
</style>

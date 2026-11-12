<script lang="ts" generics="T extends string">
	/**
	 * Tabs that switch what a panel shows in place (the desktop's full-screen
	 * controls), where TabNav is for tabs that are links. A real `tablist`:
	 * the chosen tab is the one Tab stop, and the arrow keys, Home and End
	 * move between tabs. The tabs share the row evenly. `panel` is the id of
	 * the element the tabs control; it should have `role="tabpanel"`.
	 */
	let {
		label,
		tabs,
		panel,
		value = $bindable()
	}: {
		label: string;
		tabs: readonly { value: T; label: string }[];
		panel: string;
		value: T;
	} = $props();

	let list = $state<HTMLElement>();

	/** The tab a key moves to from `index`, wrapping round; undefined for other keys. */
	function target(key: string, index: number): number | undefined {
		const count = tabs.length;
		switch (key) {
			case 'ArrowRight':
				return (index + 1) % count;
			case 'ArrowLeft':
				return (index - 1 + count) % count;
			case 'Home':
				return 0;
			case 'End':
				return count - 1;
			default:
				return undefined;
		}
	}

	function onKeyDown(event: KeyboardEvent): void {
		const next = target(
			event.key,
			tabs.findIndex((tab) => tab.value === value)
		);
		const tab = next === undefined ? undefined : tabs[next];
		if (next === undefined || tab === undefined) {
			return;
		}
		event.preventDefault();
		value = tab.value;
		list?.querySelectorAll<HTMLElement>('[role="tab"]')[next]?.focus();
	}
</script>

<div
	class="bar"
	role="tablist"
	aria-label={label}
	tabindex="-1"
	bind:this={list}
	onkeydown={onKeyDown}
>
	{#each tabs as tab (tab.value)}
		<button
			data-raw-button="tab"
			type="button"
			role="tab"
			class="item"
			aria-selected={tab.value === value}
			aria-controls={panel}
			tabindex={tab.value === value ? 0 : -1}
			onclick={() => (value = tab.value)}>{tab.label}</button
		>
	{/each}
</div>

<style>
	.bar {
		display: flex;
		gap: var(--space-0-5);
		padding: var(--space-0-5);
		border-radius: var(--radius-pill);
		background: var(--surface-muted);
	}

	.item {
		flex: 1 1 0;
		min-width: 0;
		min-height: 40px;
		padding: 0 var(--space-2);
		border: 0;
		border-radius: var(--radius-pill);
		background: transparent;
		color: var(--text-soft);
		font-size: var(--text-sm);
		font-weight: var(--weight-medium);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		cursor: pointer;
	}

	.item:hover {
		color: var(--text);
	}

	.item[aria-selected='true'] {
		background: var(--surface-elevated);
		color: var(--text);
		box-shadow: var(--shadow-card);
	}
</style>

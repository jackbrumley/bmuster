<script lang="ts">
	import { onMount } from 'svelte';
	import { IconDeviceDesktop, IconMoon, IconSun } from '@tabler/icons-svelte-runes';

	/**
	 * System / Light / Dark. The choice is kept in this browser only
	 * (localStorage `bmuster-theme`); app.html applies it before first paint.
	 */
	type Theme = 'system' | 'light' | 'dark';

	const STORAGE_KEY = 'bmuster-theme';

	function readTheme(): Theme {
		const value = document.documentElement.dataset['theme'];
		return value === 'light' || value === 'dark' ? value : 'system';
	}

	let theme = $state<Theme>('system');

	onMount(() => {
		theme = readTheme();
	});

	function choose(next: Theme): void {
		theme = next;
		if (next === 'system') {
			delete document.documentElement.dataset['theme'];
			localStorage.removeItem(STORAGE_KEY);
		} else {
			document.documentElement.dataset['theme'] = next;
			localStorage.setItem(STORAGE_KEY, next);
		}
	}

	const options = [
		{ id: 'system', label: 'System', icon: IconDeviceDesktop },
		{ id: 'light', label: 'Light', icon: IconSun },
		{ id: 'dark', label: 'Dark', icon: IconMoon }
	] as const;
</script>

<div class="switch" role="group" aria-label="Theme">
	{#each options as option (option.id)}
		<button
			type="button"
			aria-pressed={theme === option.id}
			aria-label={option.label}
			title={option.label}
			onclick={() => {
				choose(option.id);
			}}
		>
			<option.icon size={16} />
		</button>
	{/each}
</div>

<style>
	.switch {
		display: grid;
		grid-template-columns: repeat(3, 1fr);
		gap: var(--space-1);
		padding: var(--space-1);
		border-radius: var(--radius-pill);
		background: var(--surface-muted);
	}

	button {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		height: 28px;
		border: none;
		border-radius: var(--radius-pill);
		background: transparent;
		color: var(--muted);
		cursor: pointer;
	}

	button[aria-pressed='true'] {
		background: var(--surface-elevated);
		color: var(--text);
		box-shadow: var(--shadow-card);
	}
</style>

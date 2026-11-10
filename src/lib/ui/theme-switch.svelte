<script lang="ts">
	import { onMount } from 'svelte';
	import { IconDeviceDesktop, IconMoon, IconSun } from '@tabler/icons-svelte-runes';

	/**
	 * System / Light / Dark (SPEC-BRAND-ICON). Light is the default; the choice
	 * is kept in this browser only (localStorage `bmuster-theme`: 'light',
	 * 'system' or 'dark') and app.html applies it before first paint. System
	 * sets no `data-theme`, so the page follows the device.
	 */
	type Theme = 'system' | 'light' | 'dark';

	const STORAGE_KEY = 'bmuster-theme';

	function readTheme(): Theme {
		const value = document.documentElement.dataset['theme'];
		return value === 'light' || value === 'dark' ? value : 'system';
	}

	let theme = $state<Theme>('light');

	onMount(() => {
		theme = readTheme();
	});

	/** The browser bar colour follows the choice, as app.html sets it at start. */
	function applyBarColour(next: Theme): void {
		for (const meta of document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')) {
			const scheme = meta.dataset['scheme'];
			if (scheme === undefined) continue;
			meta.media =
				next === 'system'
					? `(prefers-color-scheme: ${scheme})`
					: scheme === next
						? 'all'
						: 'not all';
		}
	}

	function choose(next: Theme): void {
		theme = next;
		if (next === 'system') {
			delete document.documentElement.dataset['theme'];
		} else {
			document.documentElement.dataset['theme'] = next;
		}
		localStorage.setItem(STORAGE_KEY, next);
		applyBarColour(next);
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
			data-raw-button="segment"
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

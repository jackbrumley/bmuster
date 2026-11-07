<script lang="ts">
	import { refreshAll } from '$app/navigation';
	import PageHeader from '#lib/ui/page-header.svelte';
	import SegmentedControl from '#lib/ui/segmented-control.svelte';
	import { showToast } from '#lib/ui/toast.svelte.ts';
	import { apiRequest } from '#lib/utils/api-client.ts';
	import { settingsReplySchema } from '#lib/schemas/settings/settings.ts';
	import {
		SETTING_DEFINITIONS,
		type SettingView
	} from '#lib/domain/settings/settings-definitions.ts';
	import type { PageProps } from './$types';

	/** Server settings (SPEC-SIGN-IN S16): each one saves when changed, and is audited. */
	let { data }: PageProps = $props();

	const ON_OFF: { value: 'on' | 'off'; label: string }[] = [
		{ value: 'on', label: 'On' },
		{ value: 'off', label: 'Off' }
	];

	function options(setting: SettingView): readonly { value: string; label: string }[] {
		const control = SETTING_DEFINITIONS[setting.key].control;
		switch (control.kind) {
			case 'switch':
				return ON_OFF;
			case 'choice':
				return control.options;
		}
	}

	function shown(setting: SettingView): string {
		if (typeof setting.value === 'boolean') {
			return setting.value ? 'on' : 'off';
		}
		return setting.value;
	}

	async function change(setting: SettingView, picked: string): Promise<void> {
		const value =
			SETTING_DEFINITIONS[setting.key].control.kind === 'switch' ? picked === 'on' : picked;
		if (value === setting.value) {
			return;
		}
		const result = await apiRequest({
			method: 'PATCH',
			url: '/api/settings',
			body: { key: setting.key, value },
			reply: settingsReplySchema
		});
		showToast(
			result.ok ? `“${SETTING_DEFINITIONS[setting.key].label}” is saved.` : result.message,
			result.ok ? 'success' : 'error'
		);
		await refreshAll();
	}
</script>

<PageHeader
	title="Settings"
	summary="How this server behaves. Every change is in Activity."
	actions={undefined}
/>

<ul class="list">
	{#each data.settings as setting (setting.key)}
		{@const definition = SETTING_DEFINITIONS[setting.key]}
		<li class="setting">
			<div class="text">
				<h2>{definition.label}</h2>
				<p>{definition.description}</p>
			</div>
			<SegmentedControl
				label={definition.label}
				options={options(setting)}
				bind:value={() => shown(setting), (picked: string) => void change(setting, picked)}
			/>
		</li>
	{/each}
</ul>

<style>
	.list {
		margin: 0;
		padding: 0;
		list-style: none;
		border: 1px solid var(--border);
		border-radius: var(--radius-card);
		background: var(--surface-elevated);
		overflow: hidden;
	}

	.setting {
		display: grid;
		gap: var(--space-3);
		padding: var(--space-4);
	}

	.setting + .setting {
		border-top: 1px solid var(--border);
	}

	h2 {
		font-size: var(--text-base);
		font-weight: var(--weight-semibold);
	}

	.text p {
		color: var(--muted);
		font-size: var(--text-sm);
	}
</style>

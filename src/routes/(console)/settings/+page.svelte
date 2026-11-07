<script lang="ts">
	import { refreshAll } from '$app/navigation';
	import ListCard from '#lib/ui/list-card.svelte';
	import ListRow from '#lib/ui/list-row.svelte';
	import PageHeader from '#lib/ui/page-header.svelte';
	import SegmentedControl from '#lib/ui/segmented-control.svelte';
	import { showToast } from '#lib/ui/toast.svelte.ts';
	import { apiRequest } from '#lib/utils/api-client.ts';
	import {
		renewCertificateReplySchema,
		settingsReplySchema
	} from '#lib/schemas/settings/settings.ts';
	import {
		SETTING_DEFINITIONS,
		SETTING_SECTIONS,
		type SettingView
	} from '#lib/domain/settings/settings-definitions.ts';
	import LocalNetworkMode from './local-network-mode.svelte';
	import type { PageProps } from './$types';

	/** Server settings (SPEC-SIGN-IN S16): each one saves when changed, and is audited. */
	let { data }: PageProps = $props();

	const ON_OFF: { value: 'on' | 'off'; label: string }[] = [
		{ value: 'on', label: 'On' },
		{ value: 'off', label: 'Off' }
	];

	const sections = $derived(
		SETTING_SECTIONS.map((section) => ({
			...section,
			settings: data.settings.filter(
				(setting) => SETTING_DEFINITIONS[setting.key].section === section.id
			)
		})).filter((section) => section.settings.length > 0)
	);

	function options(setting: SettingView): readonly { value: string; label: string }[] {
		const control = SETTING_DEFINITIONS[setting.key].control;
		switch (control.kind) {
			case 'switch':
			case 'local-network-mode':
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

	async function save(setting: SettingView, value: string | boolean, saved: string): Promise<void> {
		const result = await apiRequest({
			method: 'PATCH',
			url: '/api/settings',
			body: { key: setting.key, value },
			reply: settingsReplySchema
		});
		showToast(result.ok ? saved : result.message, result.ok ? 'success' : 'error');
		await refreshAll();
	}

	async function change(setting: SettingView, picked: string): Promise<void> {
		const value =
			SETTING_DEFINITIONS[setting.key].control.kind === 'switch' ? picked === 'on' : picked;
		if (value === setting.value) {
			return;
		}
		await save(setting, value, `“${SETTING_DEFINITIONS[setting.key].label}” is saved.`);
	}

	async function renewCertificate(): Promise<void> {
		const result = await apiRequest({
			method: 'POST',
			url: '/api/local-certificate',
			body: {},
			reply: renewCertificateReplySchema
		});
		showToast(
			result.ok ? 'New certificate made. Restart BMuster to apply.' : result.message,
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

{#snippet settingRow(setting: SettingView)}
	{@const definition = SETTING_DEFINITIONS[setting.key]}
	<ListRow action={{ kind: 'static' }} align="start" dimmed={false}>
		{#if definition.control.kind === 'local-network-mode'}
			<LocalNetworkMode
				localTls={data.localTls}
				save={(on: boolean) =>
					save(
						setting,
						on,
						`Local network mode is ${on ? 'on' : 'off'}. Restart BMuster to apply.`
					)}
				renew={renewCertificate}
			/>
		{:else}
			<div class="setting">
				<div class="text">
					<h3>{definition.label}</h3>
					<p>{definition.description}</p>
				</div>
				<SegmentedControl
					label={definition.label}
					options={options(setting)}
					bind:value={() => shown(setting), (picked: string) => void change(setting, picked)}
				/>
			</div>
		{/if}
	</ListRow>
{/snippet}

{#each sections as section (section.id)}
	<ListCard
		heading={section.title}
		actions={undefined}
		label={section.title}
		items={section.settings}
		key={(setting: SettingView) => setting.key}
		row={settingRow}
		empty="No settings here."
	/>
{/each}

<style>
	.setting {
		display: grid;
		flex: 1;
		grid-template-columns: minmax(0, 1fr);
		gap: var(--space-3);
		min-width: 0;
	}

	h3 {
		font-size: var(--text-base);
		font-weight: var(--weight-semibold);
	}

	.text p {
		color: var(--muted);
		font-size: var(--text-sm);
	}
</style>

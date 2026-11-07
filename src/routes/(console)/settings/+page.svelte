<script lang="ts">
	import { refreshAll } from '$app/navigation';
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

{#each sections as section (section.id)}
	<section class="section" aria-labelledby="section-{section.id}">
		<h2 id="section-{section.id}">{section.title}</h2>
		<ul class="list">
			{#each section.settings as setting (setting.key)}
				{@const definition = SETTING_DEFINITIONS[setting.key]}
				<li>
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
				</li>
			{/each}
		</ul>
	</section>
{/each}

<style>
	.section {
		display: grid;
		gap: var(--space-2);
	}

	.section + .section {
		margin-top: var(--space-6);
	}

	h2 {
		color: var(--muted);
		font-size: var(--text-xs);
		font-weight: var(--weight-semibold);
		text-transform: uppercase;
		letter-spacing: var(--tracking-caps);
	}

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

	li + li {
		border-top: 1px solid var(--border);
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

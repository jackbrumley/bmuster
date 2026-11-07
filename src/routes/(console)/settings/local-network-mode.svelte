<script lang="ts">
	import { IconRefresh } from '@tabler/icons-svelte-runes';
	import { SETTING_DEFINITIONS } from '#lib/domain/settings/settings-definitions.ts';
	import type { LocalTlsStatus } from '#lib/domain/settings/local-tls.ts';
	import Button from '#lib/ui/button.svelte';
	import Checkbox from '#lib/ui/checkbox.svelte';
	import { confirmAction } from '#lib/ui/confirm-action.svelte.ts';
	import CopyField from '#lib/ui/copy-field.svelte';
	import Modal from '#lib/ui/modal.svelte';
	import SegmentedControl from '#lib/ui/segmented-control.svelte';

	/**
	 * Local network mode (SPEC-INSTALL-OPTIONS L1, L2, L7). Turning it on asks
	 * the admin to read what it means and tick "I understand"; turning it off
	 * is confirmed. `save` sends the change and refreshes the page; the change
	 * applies when BMuster restarts. `renew` makes a new certificate.
	 */
	let {
		localTls,
		save,
		renew
	}: {
		localTls: LocalTlsStatus;
		save: (on: boolean) => Promise<void>;
		renew: () => Promise<void>;
	} = $props();

	const definition = SETTING_DEFINITIONS.localNetworkMode;
	const ON_OFF = [
		{ value: 'on', label: 'On' },
		{ value: 'off', label: 'Off' }
	] as const;

	let asking = $state(false);
	let understood = $state(false);
	let mustTick = $state(false);

	async function pick(picked: 'on' | 'off'): Promise<void> {
		const on = picked === 'on';
		if (on === localTls.on) {
			return;
		}
		if (on) {
			understood = false;
			mustTick = false;
			asking = true;
			return;
		}
		const yes = await confirmAction({
			title: 'Turn off local network mode?',
			message:
				'After a restart BMuster serves plain HTTP again, for a reverse proxy with a publicly trusted certificate to sit in front. Connected agents are told to expect that certificate; agents that cannot reach it lose contact.',
			confirmLabel: 'Turn off'
		});
		if (yes) {
			await save(false);
		}
	}

	async function turnOn(): Promise<void> {
		if (!understood) {
			mustTick = true;
			return;
		}
		asking = false;
		await save(true);
	}

	async function askRenew(): Promise<void> {
		const yes = await confirmAction({
			title: 'Make a new certificate?',
			message:
				'BMuster makes a new certificate for its current names and addresses and serves it after the next restart. Connected agents learn its pin now; browsers warn once more. Machines that are offline until after the restart must be enrolled again.',
			confirmLabel: 'Make a new certificate'
		});
		if (yes) {
			await renew();
		}
	}
</script>

<div class="setting">
	<div class="text">
		<h3>{definition.label}</h3>
		<p>{definition.description}</p>
	</div>
	<SegmentedControl
		label={definition.label}
		options={ON_OFF}
		bind:value={() => (localTls.on ? 'on' : 'off'), (picked: 'on' | 'off') => void pick(picked)}
	/>

	{#if localTls.restartNeeded}
		<p class="restart" role="status">Restart BMuster to apply.</p>
	{/if}

	{#if localTls.on && localTls.served.kind === 'pin'}
		<div class="certificate">
			<p class="label">Certificate pin (agents and install commands use it)</p>
			<CopyField value={localTls.served.pin} label="certificate pin" />
			<p class="label">SHA-256 fingerprint (as browsers show it)</p>
			<code class="fingerprint">{localTls.served.fingerprint}</code>
		</div>
	{/if}
	{#if localTls.on}
		<div>
			<Button
				variant="secondary"
				size="compact"
				type="button"
				onclick={() => {
					void askRenew();
				}}
			>
				<IconRefresh size={18} /> Make a new certificate
			</Button>
		</div>
	{/if}
</div>

<Modal
	open={asking}
	title="Turn on local network mode?"
	onclose={() => {
		asking = false;
	}}
>
	<ul class="points">
		<li>BMuster serves HTTPS itself, with a certificate it makes. No reverse proxy is needed.</li>
		<li>
			Browsers warn about that certificate the first time. Check its fingerprint, then accept it.
		</li>
		<li>
			Use this only on a network you control. Never expose this server to the internet in this mode.
		</li>
		<li>
			Agents trust only this server's certificate: install commands carry its pin, and agents refuse
			anything else.
		</li>
	</ul>
	<p class="note">It takes effect when BMuster restarts.</p>
	<Checkbox
		label="I understand"
		error={mustTick ? 'Tick “I understand” to turn it on.' : undefined}
		bind:checked={understood}
	/>
	{#snippet footer()}
		<Button
			variant="secondary"
			size="compact"
			type="button"
			onclick={() => {
				asking = false;
			}}
		>
			Cancel
		</Button>
		<Button
			variant="primary"
			size="compact"
			type="button"
			onclick={() => {
				void turnOn();
			}}
		>
			Turn on
		</Button>
	{/snippet}
</Modal>

<style>
	.setting {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: var(--space-3);
		padding: var(--space-4);
	}

	h3 {
		font-size: var(--text-base);
		font-weight: var(--weight-semibold);
	}

	.text p,
	.note {
		color: var(--muted);
		font-size: var(--text-sm);
	}

	.restart {
		color: var(--warning);
		font-size: var(--text-sm);
		font-weight: var(--weight-semibold);
	}

	.certificate {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: var(--space-2);
	}

	.label {
		color: var(--muted);
		font-size: var(--text-xs);
		font-weight: var(--weight-medium);
	}

	.fingerprint {
		font-family: var(--font-mono);
		font-size: var(--text-xs);
		overflow-wrap: anywhere;
	}

	.points {
		display: grid;
		gap: var(--space-2);
		margin: 0;
		padding-left: var(--space-5);
		color: var(--text-soft);
		font-size: var(--text-sm);
	}
</style>

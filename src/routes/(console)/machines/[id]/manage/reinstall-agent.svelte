<script lang="ts">
	import { resolve } from '$app/paths';
	import { IconDownload, IconRefresh } from '@tabler/icons-svelte-runes';
	import {
		manualInstallCommand,
		oneLineInstallCommand,
		type AgentDownload
	} from '#lib/domain/machines/agent-release.ts';
	import type { Machine } from '#lib/domain/machines/machine.ts';
	import { installPin, type LocalTlsStatus } from '#lib/domain/settings/local-tls.ts';
	import { createJoinCodeReplySchema } from '#lib/schemas/machines/join-codes.ts';
	import Button from '#lib/ui/button.svelte';
	import Panel from '#lib/ui/panel.svelte';
	import CopyField from '#lib/ui/copy-field.svelte';
	import { apiRequest } from '#lib/utils/api-client.ts';
	import { formatBytes } from '#lib/utils/format.ts';
	import CertificatePin from '../../../add/certificate-pin.svelte';
	import JoinCodeStatus from '../../../add/join-code-status.svelte';
	import type { CodeState } from '../../../add/join-code.ts';

	/**
	 * Reinstall agent (SPEC-MACHINE-DETAILS D9): a single-use, 60-minute code
	 * tied to this machine, and the same install commands as Add machine.
	 * Enrolling with it keeps this machine's entry (name, description, notes,
	 * history) and swaps in the new agent's key; the old agent is refused.
	 */
	let {
		machine,
		origin,
		downloads,
		localTls
	}: {
		machine: Machine;
		origin: string;
		downloads: AgentDownload[];
		localTls: LocalTlsStatus;
	} = $props();

	let code = $state<CodeState>({ kind: 'none' });
	const pin = $derived(installPin(localTls));
	const download = $derived(downloads.find((item) => item.target === machine.target));
	const os = $derived(machine.osFamily === 'windows' ? 'windows' : 'linux');

	async function makeCode(): Promise<void> {
		code = { kind: 'making' };
		const result = await apiRequest({
			method: 'POST',
			url: `/api/machines/${machine.id}/reinstall-code`,
			body: undefined,
			reply: createJoinCodeReplySchema
		});
		code = result.ok
			? {
					kind: 'ready',
					id: result.data.id,
					code: result.data.code,
					expiresAtIso: result.data.expiresAtIso,
					maxUses: result.data.maxUses
				}
			: { kind: 'failed', message: result.message };
	}

	function expiryTime(iso: string): string {
		return new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
	}
</script>

<Panel heading="Reinstall agent" actions={undefined} tone="normal" padding="normal">
	<p class="muted">
		For a rebuilt machine or a broken agent. Install with this code and the new agent takes over
		this entry: same name, description, notes and history. The old agent is refused from then on.
	</p>

	{#if machine.osFamily === 'macos'}
		<p class="muted">The macOS agent is not built yet.</p>
	{:else if code.kind === 'none'}
		<div>
			<Button
				variant="secondary"
				size="compact"
				type="button"
				onclick={() => {
					void makeCode();
				}}><IconRefresh size={18} /> Make a reinstall code</Button
			>
		</div>
	{:else if code.kind === 'making'}
		<p class="muted">Making a reinstall code…</p>
	{:else if code.kind === 'failed'}
		<p class="error">{code.message}</p>
		<div>
			<Button
				variant="secondary"
				size="compact"
				type="button"
				onclick={() => {
					void makeCode();
				}}><IconRefresh size={18} /> Try again</Button
			>
		</div>
	{:else}
		<div class="code-block">
			<p class="label">Reinstall code</p>
			<p class="code">{code.code}</p>
			<p class="muted">
				Works once, only for {machine.name}. Expires at {expiryTime(code.expiresAtIso)}.
			</p>
			<JoinCodeStatus
				codeId={code.id}
				mode={{
					kind: 'single',
					onNewCode: () => {
						void makeCode();
					}
				}}
			/>
		</div>

		{#if localTls.on}
			<CertificatePin {localTls} />
		{/if}

		<div class="step">
			<p class="label">
				{os === 'windows'
					? 'On the machine, in PowerShell as administrator'
					: 'On the machine, in a terminal'}
			</p>
			<CopyField
				value={oneLineInstallCommand(os, origin, code.code, pin)}
				label="reinstall command"
			/>
		</div>

		<div class="step">
			<p class="label">Or install manually: download the agent, then run this beside it</p>
			{#if download?.kind === 'ready'}
				<a
					class="download"
					href={resolve('/agent/v1/releases/[version]/[target]', {
						version: download.version,
						target: download.target
					})}
					download
				>
					<IconDownload size={18} /> Download agent
				</a>
				<p class="muted">
					Version {download.version} for {download.target} · {formatBytes(download.size)} · SHA-256 below
				</p>
				<CopyField value={download.sha256} label="SHA-256" />
			{:else}
				<p class="muted">This server has no agent build for {machine.target}.</p>
			{/if}
			<CopyField
				value={manualInstallCommand(os, origin, code.code, pin)}
				label="manual reinstall command"
			/>
		</div>
	{/if}
</Panel>

<style>
	.muted {
		color: var(--muted);
		font-size: var(--text-sm);
	}

	.error {
		color: var(--danger);
		font-size: var(--text-sm);
	}

	.code-block,
	.step {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: var(--space-2);
	}

	.label {
		color: var(--text-soft);
		font-size: var(--text-xs);
		font-weight: var(--weight-medium);
	}

	.code {
		font-family: var(--font-mono);
		font-size: var(--text-2xl);
		font-weight: var(--weight-bold);
		letter-spacing: var(--tracking-caps);
	}

	.download {
		justify-self: start;
		display: inline-flex;
		align-items: center;
		gap: var(--space-2);
		min-height: 40px;
		padding: var(--space-2) var(--space-4);
		border-radius: var(--radius-pill);
		border: 1px solid var(--border-strong);
		color: var(--text);
		font-size: var(--text-sm);
		font-weight: var(--weight-semibold);
		text-decoration: none;
	}
</style>

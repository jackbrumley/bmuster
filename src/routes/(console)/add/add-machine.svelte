<script lang="ts">
	import { onMount } from 'svelte';
	import Button from '#lib/ui/button.svelte';
	import {
		IconBrandApple,
		IconBrandUbuntu,
		IconBrandWindows,
		IconKey,
		IconRefresh
	} from '@tabler/icons-svelte-runes';
	import CopyField from '#lib/ui/copy-field.svelte';
	import Panel from '#lib/ui/panel.svelte';
	import {
		hasBuildFor,
		oneLineInstallCommand,
		type AgentDownload
	} from '#lib/domain/machines/agent-release.ts';
	import type { OsFamily } from '#lib/domain/machines/machine.ts';
	import { installPin, type LocalTlsStatus } from '#lib/domain/settings/local-tls.ts';
	import CertificatePin from './certificate-pin.svelte';
	import InstallManually from './install-manually.svelte';
	import JoinCodeStatus from './join-code-status.svelte';
	import PhoneSupport from './phone-support.svelte';
	import { makeJoinCode, type CodeState } from './join-code.ts';

	/**
	 * Manual install (SPEC-ENROLMENT 4): a join code and one-line install
	 * command, with a downloadable-agent option underneath (SPEC-INSTALL-OPTIONS M1–M4).
	 * In local network mode the commands carry the certificate pin (L5, L6).
	 * Quick join (SPEC-JOIN J12) is the primary path and carries its own groups.
	 */
	let {
		origin,
		downloads,
		devServer,
		localTls,
		machineGroups
	}: {
		/** This server's address, as the machine will reach it. */
		origin: string;
		downloads: AgentDownload[];
		/** Running under `npm run dev`: hints name the developer's commands. */
		devServer: boolean;
		localTls: LocalTlsStatus;
		/** Groups a join code can put the machine in (not All machines). */
		machineGroups: { id: string; name: string }[];
	} = $props();

	let joinCode = $state<CodeState>({ kind: 'none' });
	let groupIds = $state<string[]>([]);
	let target = $state<OsFamily | undefined>(undefined);
	const pin = $derived(installPin(localTls));

	const targets: { id: OsFamily; label: string; icon: typeof IconBrandUbuntu }[] = [
		{ id: 'linux', label: 'Linux', icon: IconBrandUbuntu },
		{ id: 'windows', label: 'Windows', icon: IconBrandWindows },
		{ id: 'macos', label: 'macOS', icon: IconBrandApple }
	];

	async function makeCode(): Promise<void> {
		joinCode = { kind: 'making' };
		joinCode = await makeJoinCode(1, 60, groupIds);
	}

	/** A code carries its groups, so choosing other groups makes a new code. */
	function chooseGroups(ids: string[]): void {
		groupIds = ids;
		void makeCode();
	}

	// A code is ready as soon as the page opens, so the commands below are
	// complete straight away; New code makes another.
	onMount(() => {
		void makeCode();
	});

	function expiryTime(iso: string): string {
		return new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
	}
</script>

<PhoneSupport
	{origin}
	machineGroupIds={groupIds}
	{machineGroups}
	onMachineGroupsChange={chooseGroups}
/>

<Panel heading="Manual install" actions={undefined} tone="normal" padding="normal">
	<p class="intro">
		Use this when you can run an administrator command on the computer. For a code-based setup, use
		Quick join above.
	</p>
	<div class="code-row">
		<div>
			<p class="label">Join code</p>
			{#if joinCode.kind === 'ready'}
				<p class="code">{joinCode.code}</p>
				<p class="hint">Works once. Expires at {expiryTime(joinCode.expiresAtIso)}.</p>
				<JoinCodeStatus
					codeId={joinCode.id}
					mode={{
						kind: 'single',
						onNewCode: () => {
							void makeCode();
						}
					}}
				/>
			{:else if joinCode.kind === 'failed'}
				<p class="error">{joinCode.message}</p>
			{:else}
				<p class="hint">Making a join code…</p>
			{/if}
		</div>
		<Button
			variant="secondary"
			size="compact"
			type="button"
			onclick={() => {
				void makeCode();
			}}
		>
			{#if joinCode.kind === 'failed'}
				<IconKey size={18} /> Try again
			{:else}
				<IconRefresh size={18} /> New code
			{/if}
		</Button>
	</div>

	<div class="targets" role="group" aria-label="Operating system">
		{#each targets as item (item.id)}
			<button
				data-raw-button="card"
				type="button"
				class="target"
				aria-pressed={target === item.id}
				onclick={() => (target = item.id)}
			>
				<item.icon size={20} stroke={1.75} />
				{item.label}
			</button>
		{/each}
	</div>

	{#if target === undefined}
		<p class="hint">Choose the computer's operating system to see its install options.</p>
	{:else}
		{#if localTls.on}
			<CertificatePin {localTls} />
		{/if}

		{#if target === 'macos'}
			<p class="hint">The macOS agent is not built yet.</p>
		{:else if !hasBuildFor(target, downloads)}
			<div class="step">
				<p class="error">
					This server has no {target === 'windows' ? 'Windows' : 'Linux'} agent yet, so the install command
					would fail.
				</p>
				<p class="hint">
					{#if target === 'windows'}
						Windows agents are built by the release workflow on GitHub.
					{:else if devServer}
						Run <code>npm run agent:release-local</code> to build one for this computer.
					{:else}
						Install a release of BMuster that includes the agents.
					{/if}
				</p>
			</div>
		{:else if joinCode.kind === 'ready'}
			<div class="step">
				<p class="label">
					{target === 'windows' ? 'Run in PowerShell as administrator' : 'Run in a terminal'}
				</p>
				<CopyField
					value={oneLineInstallCommand(target, origin, joinCode.code, pin)}
					label="install command"
				/>
			</div>
		{/if}

		<InstallManually
			os={target}
			{origin}
			{joinCode}
			{downloads}
			{devServer}
			{pin}
			{machineGroups}
		/>
	{/if}
</Panel>

<style>
	.intro {
		color: var(--text-soft);
		font-size: var(--text-sm);
	}

	.code-row {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-4);
	}

	.label {
		color: var(--muted);
		font-size: var(--text-xs);
		font-weight: var(--weight-medium);
	}

	.code {
		font-family: var(--font-mono);
		font-size: var(--text-2xl);
		font-weight: var(--weight-bold);
		letter-spacing: var(--tracking-caps);
		text-align: center;
	}

	.hint {
		color: var(--muted);
		font-size: var(--text-xs);
	}

	.error {
		color: var(--danger);
		font-size: var(--text-sm);
	}

	.targets {
		display: grid;
		grid-template-columns: repeat(3, minmax(0, 1fr));
		gap: var(--space-2);
	}

	.target {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: var(--space-2);
		height: 44px;
		border: 1px solid var(--border);
		border-radius: var(--radius-pill);
		background: var(--surface);
		color: var(--text-soft);
		font-size: var(--text-sm);
		font-weight: var(--weight-medium);
		cursor: pointer;
	}

	.target[aria-pressed='true'] {
		border-color: var(--brand);
		background: var(--brand-tint);
		color: var(--brand);
	}

	.step {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: var(--space-2);
	}
</style>

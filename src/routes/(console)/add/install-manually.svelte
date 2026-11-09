<script lang="ts">
	import { resolve } from '$app/paths';
	import { IconChevronRight, IconDownload } from '@tabler/icons-svelte-runes';
	import {
		manualInstallCommand,
		type AgentDownload,
		type AgentTarget
	} from '#lib/domain/machines/agent-release.ts';
	import type { OsFamily } from '#lib/domain/machines/machine.ts';
	import type { ServedPin } from '#lib/domain/settings/local-tls.ts';
	import CopyField from '#lib/ui/copy-field.svelte';
	import SegmentedControl from '#lib/ui/segmented-control.svelte';
	import RadarSpinner from '#lib/ui/radar-spinner.svelte';
	import { formatBytes } from '#lib/utils/format.ts';
	import type { CodeState } from './join-code.ts';
	import RolloutCode from './rollout-code.svelte';

	/**
	 * Install manually (SPEC-INSTALL-OPTIONS M1–M4): for machines that cannot
	 * run the one-line command (deployment tools, locked-down Windows, no curl,
	 * offline networks, or an admin who wants to check the file first).
	 */
	let {
		os,
		origin,
		joinCode,
		downloads,
		devServer,
		pin,
		machineGroups
	}: {
		os: OsFamily;
		origin: string;
		/** The page's single-use join code. */
		joinCode: CodeState;
		downloads: AgentDownload[];
		devServer: boolean;
		/** The certificate pin the command carries in local network mode. */
		pin: ServedPin;
		/** For the roll-out code's group picker (SPEC-ACCESS A7). */
		machineGroups: { id: string; name: string }[];
	} = $props();

	/** The processor is the admin's choice: nothing is picked until they pick it. */
	type TargetChoice = { kind: 'none' } | { kind: 'chosen'; target: AgentTarget };

	let linuxChoice = $state<TargetChoice>({ kind: 'none' });

	const linuxTargets = [
		{ value: 'x86_64-unknown-linux-gnu', label: 'x86_64 (Intel, AMD)' },
		{ value: 'aarch64-unknown-linux-gnu', label: 'aarch64 (ARM)' }
	] as const;

	// Windows has one build, so it is chosen straight away.
	const choice = $derived<TargetChoice>(
		os === 'windows' ? { kind: 'chosen', target: 'x86_64-pc-windows-msvc' } : linuxChoice
	);

	function chooseLinux(target: AgentTarget | null): void {
		linuxChoice = target === null ? { kind: 'none' } : { kind: 'chosen', target };
	}

	function downloadFor(target: AgentTarget): AgentDownload {
		return downloads.find((item) => item.target === target) ?? { kind: 'none', target };
	}
</script>

<details class="manual">
	<summary>
		<IconChevronRight size={18} />
		Download the agent file
	</summary>

	<div class="body">
		{#if os === 'macos'}
			<p class="hint">The macOS agent is not built yet.</p>
		{:else}
			<p class="hint">
				Download the agent, copy it to the machine, and run one command beside it. Use this for
				deployment tools, machines without curl or behind a proxy, offline networks, or to check the
				file first.
			</p>

			{#if os === 'linux'}
				<SegmentedControl
					label="Processor"
					options={linuxTargets}
					bind:value={
						() => (linuxChoice.kind === 'chosen' ? linuxChoice.target : null), chooseLinux
					}
				/>
			{/if}

			{#if choice.kind === 'none'}
				<p class="hint">Choose the machine's processor to see its download.</p>
			{:else}
				{@const download = downloadFor(choice.target)}
				{#if download.kind === 'ready'}
					<div class="step">
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
						<p class="hint">
							Version {download.version} for {download.target} · {formatBytes(download.size)}
						</p>
					</div>
					<div class="step">
						<p class="label">SHA-256 (check the downloaded file against it)</p>
						<CopyField value={download.sha256} label="SHA-256" />
					</div>
				{:else}
					<div class="step">
						<p class="missing">This server has no agent build for {download.target} yet.</p>
						{#if devServer}
							<p class="hint">
								Run <code>npm run agent:release-local</code> to build one for this computer.
							</p>
						{/if}
					</div>
				{/if}
			{/if}

			<div class="step">
				<p class="label">
					{os === 'windows'
						? 'Then, in PowerShell as Administrator, in the folder with the file'
						: 'Then, in a terminal, in the folder with the file'}
				</p>
				{#if joinCode.kind === 'ready'}
					<CopyField
						value={manualInstallCommand(os, origin, joinCode.code, pin)}
						label="manual install command"
					/>
				{:else if joinCode.kind === 'failed'}
					<p class="hint">No join code: {joinCode.message}</p>
				{:else}
					<p class="hint"><RadarSpinner size="small" /> Making a join code</p>
				{/if}
			</div>

			<RolloutCode {os} {origin} {pin} {machineGroups} />
		{/if}
	</div>
</details>

<style>
	.manual {
		border-top: 1px solid var(--border);
		padding-top: var(--space-4);
	}

	summary {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		min-height: 40px;
		color: var(--text-soft);
		font-size: var(--text-sm);
		font-weight: var(--weight-medium);
		list-style: none;
		cursor: pointer;
	}

	summary::-webkit-details-marker {
		display: none;
	}

	summary :global(svg) {
		transition: transform 150ms ease;
	}

	.manual[open] summary :global(svg) {
		transform: rotate(90deg);
	}

	.body {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: var(--space-4);
		padding-top: var(--space-4);
	}

	.step {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: var(--space-2);
	}

	.download {
		justify-self: start;
		display: inline-flex;
		align-items: center;
		gap: var(--space-2);
		min-height: 40px;
		padding: var(--space-2) var(--space-4);
		border-radius: var(--radius-pill);
		background: var(--brand);
		color: var(--brand-contrast);
		font-size: var(--text-sm);
		font-weight: var(--weight-semibold);
		text-decoration: none;
	}

	.download:hover {
		background: var(--brand-hover);
	}

	.label {
		color: var(--muted);
		font-size: var(--text-xs);
		font-weight: var(--weight-medium);
	}

	.hint {
		color: var(--muted);
		font-size: var(--text-xs);
	}

	.missing {
		color: var(--warning);
		font-size: var(--text-sm);
	}

	code {
		font-family: var(--font-mono);
	}
</style>

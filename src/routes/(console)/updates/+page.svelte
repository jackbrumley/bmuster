<script lang="ts">
	import { onMount } from 'svelte';
	import ServerUpdatePanel from './server-update-panel.svelte';
	import { refreshAll } from '$app/navigation';
	import { resolve } from '$app/paths';
	import {
		IconCircleCheck,
		IconCircleX,
		IconPlayerPause,
		IconPlayerPlay
	} from '@tabler/icons-svelte-runes';
	import { CHANGELOG } from '#lib/domain/releases/changelog.ts';
	import { stageLabel } from '#lib/domain/machines/agent-updates.ts';
	import { rolloutReplySchema } from '#lib/schemas/machines/agent-updates.ts';
	import { serverUpdateViewSchema } from '#lib/schemas/releases/server-updates.ts';
	import Button from '#lib/ui/button.svelte';
	import FullScreenWait from '#lib/ui/full-screen-wait.svelte';
	import ListCard from '#lib/ui/list-card.svelte';
	import ListRow from '#lib/ui/list-row.svelte';
	import Notice from '#lib/ui/notice.svelte';
	import PageHeader from '#lib/ui/page-header.svelte';
	import Panel from '#lib/ui/panel.svelte';
	import { showToast } from '#lib/ui/toast.svelte.ts';
	import { apiRequest } from '#lib/utils/api-client.ts';
	import { formatRelative } from '#lib/utils/format.ts';
	import ReleaseNotes from './release-notes.svelte';
	import TestChannelPanel from './test-channel-panel.svelte';
	import UpdateMachines from './update-machines.svelte';
	import { startServerRestartMonitor, type RestartProgress } from './server-restart-monitor.ts';
	import { reloadPage } from './reload-page.ts';
	import { updateWaitLine } from '#lib/domain/releases/update-wait.ts';
	import type { PageProps } from './$types';

	/**
	 * Updates (SPEC-AGENT-UPDATES): which agent version is on offer and how far its staged
	 * roll-out has got, every machine's version and update state, Pause and Update now.
	 */
	let { data }: PageProps = $props();
	/** After Update now: the version being installed, the updater's latest step and when it began (SPEC-LOADING). */
	let restart = $state<
		{ kind: 'none' } | { kind: 'restarting'; version: string; detail: string; startedMs: number }
	>({
		kind: 'none'
	});
	/** Ticks once a second while the server updates, for the countdown (SU14). */
	let nowMs = $state(Date.now());
	let restartMonitor: ReturnType<typeof startServerRestartMonitor> | undefined;
	onMount(() => {
		const timer = setInterval(() => {
			if (restart.kind === 'none' && document.visibilityState === 'visible') {
				void refreshAll();
			}
		}, 3000);
		const clock = setInterval(() => {
			if (restart.kind === 'restarting') nowMs = Date.now();
		}, 1000);
		const checkAfterTabReturns = (): void => {
			if (document.visibilityState === 'visible') restartMonitor?.checkNow();
		};
		document.addEventListener('visibilitychange', checkAfterTabReturns);
		return () => {
			clearInterval(timer);
			clearInterval(clock);
			document.removeEventListener('visibilitychange', checkAfterTabReturns);
			restartMonitor?.stop();
		};
	});

	function progressLine(progress: RestartProgress): string {
		switch (progress.kind) {
			case 'step':
				return progress.message;
			case 'unreachable':
				return 'Waiting for the server to come back';
		}
	}

	function onServerRestarting(version: string, requestedAtIso: string): void {
		nowMs = Date.now();
		restart = { kind: 'restarting', version, detail: 'Starting the update', startedMs: nowMs };
		restartMonitor?.stop();
		restartMonitor = startServerRestartMonitor({
			expectedVersion: version,
			requestedAtIso,
			read: () =>
				apiRequest({
					method: 'GET',
					url: '/api/server-updates',
					body: undefined,
					reply: serverUpdateViewSchema,
					signal: AbortSignal.timeout(5000)
				}),
			onProgress: (progress) => {
				if (restart.kind === 'restarting') restart = { ...restart, detail: progressLine(progress) };
			},
			onReturned: (result) => {
				restart = { kind: 'none' };
				switch (result.kind) {
					case 'ready':
						// The console's own code changed with the server.
						reloadPage();
						return;
					case 'failed':
						// The same version runs again: fresh data shows how the update ended.
						void refreshAll();
						return;
				}
			}
		});
	}

	/** The newest release's notes show; older ones fold away. */
	const [latest, ...earlier] = CHANGELOG;

	const earlyCount = $derived(
		`${String(data.earlyGroup.machines)} ${data.earlyGroup.machines === 1 ? 'machine' : 'machines'}`
	);

	/** Opens the Early updates group on the Groups page. */
	const earlyGroupHref = $derived(
		resolve(
			`/(console)/groups?${new URLSearchParams({ machineGroup: data.earlyGroup.id }).toString()}`
		)
	);

	type Build = (typeof data.builds)[number];

	async function setPaused(paused: boolean): Promise<void> {
		const result = await apiRequest({
			method: 'POST',
			url: '/api/agent-updates/rollout',
			body: { action: paused ? 'pause' : 'resume' },
			reply: rolloutReplySchema
		});
		if (!result.ok) {
			showToast(result.message, 'error');
			return;
		}
		showToast(paused ? 'The roll-out is paused.' : 'The roll-out goes on.', 'success');
		await refreshAll();
	}
</script>

{#if restart.kind === 'restarting'}
	<!-- What is happening, what to do and about how long, while the server updates (SU14):
	     the wait owns the screen, since nothing else can be used until BMuster is back. -->
	<FullScreenWait
		title={`BMuster is updating to ${restart.version}. Please wait.`}
		detail={`${updateWaitLine(nowMs - restart.startedMs)}. This page reloads by itself when BMuster is back. ${restart.detail}.`}
	/>
{:else}
	<PageHeader
		title="Updates"
		summary="Keep every agent on the newest signed version: in stages, automatically, with a pause for anything that goes wrong."
		actions={undefined}
	/>

	<ServerUpdatePanel view={data.server} onRestarting={onServerRestarting} />

	<Panel heading="Release notes" actions={undefined} tone="normal" padding="normal">
		<ReleaseNotes release={latest} />
		<details class="earlier">
			<summary>Earlier versions ({earlier.length})</summary>
			{#each earlier as release (release.version)}
				<ReleaseNotes {release} />
			{/each}
		</details>
	</Panel>

	{#if data.rollout.kind === 'rollout' && data.rollout.paused.kind === 'paused'}
		<Notice
			tone={data.rollout.paused.by === 'system' ? 'danger' : 'warning'}
			title="The roll-out of {data.rollout.version} is paused"
		>
			<p>
				{data.rollout.paused.reason} ({formatRelative(data.rollout.paused.atIso, data.now)}).
				Machines not yet on {data.rollout.version} wait until you resume. Update now still works for any
				machine.
			</p>
		</Notice>
	{/if}

	<Panel heading="Roll-out" actions={undefined} tone="normal" padding="normal">
		{#if data.rollout.kind === 'none'}
			<p class="muted">
				This server has no signed agent build yet, so there is nothing to offer. Release builds are
				signed; for a development build run <code>npm run agent:release-local</code>.
			</p>
		{:else}
			<dl class="facts">
				<div>
					<dt>On offer</dt>
					<dd>Version {data.rollout.version}</dd>
				</div>
				<div>
					<dt>Policy</dt>
					<dd>
						{data.policy === 'automatic' ? 'Automatic, in stages' : 'Manual: only Update now'}
						· <a href={resolve('/(console)/settings')}>change</a>
					</dd>
				</div>
				{#if data.policy === 'automatic'}
					<div>
						<dt>Stage</dt>
						<dd>
							{stageLabel(data.rollout.stage)}, since {formatRelative(
								data.rollout.stageStartedIso,
								data.now
							)}
						</dd>
					</div>
				{/if}
			</dl>
			<div>
				{#if data.rollout.paused.kind === 'paused'}
					<Button
						variant="primary"
						size="compact"
						type="button"
						onclick={() => {
							void setPaused(false);
						}}><IconPlayerPlay size={18} /> Resume roll-out</Button
					>
				{:else}
					<Button
						variant="secondary"
						size="compact"
						type="button"
						onclick={() => {
							void setPaused(true);
						}}><IconPlayerPause size={18} /> Pause roll-out</Button
					>
				{/if}
			</div>
		{/if}
		<p class="early">
			Machines in {data.earlyGroup.name} get new versions first. {earlyCount} —
			<a href={earlyGroupHref}>{data.earlyGroup.machines === 0 ? 'add one' : 'add or take out'}</a>
		</p>
	</Panel>

	<TestChannelPanel channel={data.testChannel} now={data.now} />

	<UpdateMachines machines={data.machines} now={data.now} />

	{#snippet buildRow(build: Build)}
		<ListRow action={{ kind: 'static' }} align="center" dimmed={!build.signed}>
			<span class="build">
				<span class="build-version">{build.version}</span>
				<span class="muted">{build.target}</span>
			</span>
			{#if build.signed}
				<span class="signed"><IconCircleCheck size={18} /> Signed</span>
			{:else}
				<span class="unsigned"><IconCircleX size={18} /> Not signed: install only</span>
			{/if}
		</ListRow>
	{/snippet}

	<ListCard
		heading="Builds on this server"
		actions={undefined}
		label="Agent builds, newest first"
		items={data.builds}
		key={(build: Build) => `${build.version}/${build.target}`}
		row={buildRow}
		empty="No agent builds yet."
	/>
{/if}

<style>
	.earlier summary {
		color: var(--brand);
		font-size: var(--text-sm);
		font-weight: var(--weight-medium);
		cursor: pointer;
	}

	.earlier[open] summary {
		margin-bottom: var(--space-3);
	}

	.muted {
		color: var(--muted);
		font-size: var(--text-sm);
	}

	.facts {
		display: grid;
		gap: var(--space-3);
		margin: 0;
	}

	dt {
		color: var(--text-soft);
		font-size: var(--text-xs);
		font-weight: var(--weight-medium);
	}

	dd {
		margin: 0;
		overflow-wrap: anywhere;
	}

	dd a,
	.early a {
		color: var(--brand);
	}

	.early {
		color: var(--text-soft);
		font-size: var(--text-sm);
	}

	code {
		font-family: var(--font-mono);
		font-size: var(--text-sm);
	}

	.build {
		display: grid;
		flex: 1;
		min-width: 0;
	}

	.build-version {
		font-weight: var(--weight-semibold);
		overflow-wrap: anywhere;
	}

	.signed,
	.unsigned {
		display: inline-flex;
		align-items: center;
		gap: var(--space-1);
		font-size: var(--text-sm);
		white-space: nowrap;
	}

	.signed {
		color: var(--success);
	}

	.unsigned {
		color: var(--muted);
	}
</style>

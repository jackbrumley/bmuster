<script lang="ts">
	import { refreshAll } from '$app/navigation';
	import type { ServerUpdateView } from '#lib/schemas/releases/server-updates.ts';
	import {
		serverUpdateRequestedSchema,
		serverUpdateViewSchema
	} from '#lib/schemas/releases/server-updates.ts';
	import Panel from '#lib/ui/panel.svelte';
	import Button from '#lib/ui/button.svelte';
	import Notice from '#lib/ui/notice.svelte';
	import RadarSpinner from '#lib/ui/radar-spinner.svelte';
	import { confirmAction } from '#lib/ui/confirm-action.svelte.ts';
	import { showToast } from '#lib/ui/toast.svelte.ts';
	import { apiRequest } from '#lib/utils/api-client.ts';
	let {
		view,
		onRestarting
	}: {
		view: ServerUpdateView;
		onRestarting: (version: string, requestedAtIso: string) => void;
	} = $props();
	/** What happens if the new version does not start: declared in its signed manifest. */
	function ifItFails(release: NonNullable<ServerUpdateView['release']>): string {
		return release.manifest.rollbackFrom.includes(view.installedVersion)
			? `If it does not, BMuster ${view.installedVersion} comes back automatically on the same database.`
			: `If it does not, the server stays stopped for an administrator, with a copy of the database from before the update.`;
	}
	/** What the panel is asking the server: nothing, a check, or to install. */
	let busy = $state<'idle' | 'checking' | 'installing'>('idle');
	async function check(): Promise<void> {
		if (busy !== 'idle') return;
		busy = 'checking';
		try {
			const result = await apiRequest({
				method: 'POST',
				url: '/api/server-updates/check',
				body: {},
				reply: serverUpdateViewSchema
			});
			if (!result.ok) {
				showToast(result.message, 'error');
				return;
			}
			showToast(
				result.data.problem ??
					(result.data.release === null
						? 'The server is up to date.'
						: `BMuster ${result.data.release.version} is available.`),
				result.data.problem === null ? 'success' : 'error'
			);
			await refreshAll();
		} finally {
			busy = 'idle';
		}
	}
	async function install(): Promise<void> {
		if (busy !== 'idle' || !view.install.allowed || view.release === null) return;
		const version = view.release.version;
		if (
			!(await confirmAction({
				title: `Update BMuster to ${version}?`,
				message: `${view.release.notes}\n\nThe whole server is replaced (its launcher, Node and the console), so the console restarts and active sessions end; it may be unavailable for a minute or two. The new version must start within two minutes. ${ifItFails(view.release)} Machines receive the signed agent through their configured rollout, pins and update policy.`,
				confirmLabel: 'Update now'
			}))
		)
			return;
		busy = 'installing';
		try {
			const result = await apiRequest({
				method: 'POST',
				url: '/api/server-updates/install',
				body: { version },
				reply: serverUpdateRequestedSchema
			});
			if (!result.ok) showToast(result.message, 'error');
			else {
				showToast('BMuster is updating. This page will reconnect automatically.', 'success');
				onRestarting(version, result.data.requestedAtIso);
			}
		} finally {
			busy = 'idle';
		}
	}
</script>

<Panel heading="Server" actions={undefined} tone="normal" padding="normal">
	<p>Installed version: <strong>{view.installedVersion}</strong></p>
	<p>
		{view.problem !== null && view.release !== null
			? 'Last known signed release'
			: 'Latest signed release'}:
		{view.release?.version ??
			(view.problem === null ? 'No newer release found' : 'Unable to confirm')}
	</p>
	<p>
		Last checked: {view.checkedAtIso === null
			? 'Never'
			: new Date(view.checkedAtIso).toLocaleString()}
	</p>
	{#if view.lastSuccessAtIso !== null && view.problem !== null}<p>
			Last successful check: {new Date(view.lastSuccessAtIso).toLocaleString()}
		</p>{/if}
	{#if view.problem !== null}<Notice tone="danger" title="Update check failed"
			><p>{view.problem}</p></Notice
		>{/if}
	{#if view.operation.phase !== 'idle'}<Notice
			tone={view.operation.phase === 'failed' || view.operation.phase === 'rolled-back'
				? 'warning'
				: 'info'}
			title="Server update: {view.operation.phase}"
			><p>{view.operation.message}</p>
			{#if view.operation.atIso !== null}<p>
					{new Date(view.operation.atIso).toLocaleString()}
				</p>{/if}</Notice
		>{/if}
	<div class="actions">
		{#if busy !== 'installing'}<Button
				type="button"
				variant="secondary"
				size="compact"
				onclick={() => void check()}
				>{#if busy === 'checking'}<RadarSpinner size="small" /> Checking for updates{:else}Check for
					updates{/if}</Button
			>{/if}
		{#if view.install.allowed && busy === 'idle'}<Button
				type="button"
				variant="primary"
				size="compact"
				onclick={() => void install()}>Update now</Button
			>{/if}
	</div>
	{#if !view.install.allowed}<p class="muted">{view.install.reason}</p>{/if}
	{#if view.deployment === 'docker' && view.release !== null}<p>
			Deploy <code>ghcr.io/jackbrumley/bmuster:v{view.release.version}</code> in Docker or Coolify, then
			recreate the container with its existing data volume.
		</p>{/if}
	{#if view.release !== null}<h3>What’s new in {view.release.version}</h3>
		<p class="notes">{view.release.notes}</p>{/if}
</Panel>

<style>
	.actions {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-3);
	}
	.muted {
		color: var(--muted);
	}
	.notes {
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}
</style>

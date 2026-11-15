<script lang="ts">
	import { onMount } from 'svelte';
	import { refreshAll } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { IconRobot } from '@tabler/icons-svelte-runes';
	import { recheckAsk } from '#lib/domain/auth/sign-in-check.ts';
	import { ASSISTANT_RUN_LIMITS } from '#lib/domain/commands/assistant-runs.ts';
	import {
		CLEANUP_CATALOGUE,
		sizeText,
		type CleanupItemSize
	} from '#lib/domain/storage/cleanup.ts';
	import { totalText, type CleanupApprovalView } from '#lib/domain/storage/cleanup-requests.ts';
	import { cleanupDecidedReplySchema } from '#lib/schemas/storage/cleanup.ts';
	import Button from '#lib/ui/button.svelte';
	import { confirmWithChecks } from '#lib/ui/confirm-action.svelte.ts';
	import ListCard from '#lib/ui/list-card.svelte';
	import ListRow from '#lib/ui/list-row.svelte';
	import LoadingVeil from '#lib/ui/loading-veil.svelte';
	import Notice from '#lib/ui/notice.svelte';
	import OsIcon from '#lib/ui/os-icon.svelte';
	import Panel from '#lib/ui/panel.svelte';
	import TextField from '#lib/ui/text-field.svelte';
	import { showToast } from '#lib/ui/toast.svelte.ts';
	import { apiRequest } from '#lib/utils/api-client.ts';

	/**
	 * An AI assistant's clean-up request, as the person who decides it reads it (SPEC-MCP M54): the
	 * machine, who asked and through which assistant, the assistant's reason as its own words, and
	 * each item from BMuster's safe list with the machine's own size and the total. Approve stays
	 * disabled for 2 s after the card appears, so it is read before it is pressed. Approve and Deny
	 * sit in a bar fixed to the bottom of the screen, as on a command's card.
	 */
	let { view, now }: { view: CleanupApprovalView; now: number } = $props();

	let denying = $state(false);
	let note = $state('');
	let busy = $state(false);
	let armed = $state(false);
	let elapsed = $state(0);

	onMount(() => {
		const arm = setTimeout(() => {
			armed = true;
		}, ASSISTANT_RUN_LIMITS.approveDelayMs);
		const tick = setInterval(() => {
			elapsed += 1000;
		}, 1000);
		return () => {
			clearTimeout(arm);
			clearInterval(tick);
		};
	});

	const remaining = $derived(Math.max(0, Date.parse(view.expiresIso) - (now + elapsed)));
	const remainingText = $derived(
		remaining === 0
			? 'Expired'
			: `Expires in ${String(Math.floor(remaining / 60_000))}:${String(Math.floor((remaining % 60_000) / 1000)).padStart(2, '0')}`
	);
	const runsAs = $derived(view.machine.osFamily === 'windows' ? 'SYSTEM' : 'root');
	const decide = $derived(view.state.kind === 'pending' ? view.state.decide : undefined);
	const canApprove = $derived(
		decide?.kind === 'yes' && decide.signIn.kind !== 'sign-in-again' && remaining > 0
	);
	const count = $derived(view.items.length);

	async function approve(): Promise<void> {
		if (decide?.kind !== 'yes') {
			return;
		}
		const answer = await confirmWithChecks({
			title: `Clean up ${String(count)} ${count === 1 ? 'item' : 'items'} on ${view.machine.name}?`,
			message: `About ${totalText(view.items)} is deleted for good, as ${runsAs}. Files in use are skipped.`,
			confirmLabel: 'Approve and clean up',
			typedCount: null,
			recheck: recheckAsk(decide.signIn)
		});
		if (answer.kind === 'no') {
			return;
		}
		busy = true;
		const result = await apiRequest({
			method: 'POST',
			url: resolve('/api/approvals/clean-ups/[id=uuid]/approve', { id: view.requestId }),
			body: { recheck: answer.recheck },
			reply: cleanupDecidedReplySchema
		});
		busy = false;
		showToast(
			result.ok ? 'Approved. The clean-up is running now.' : result.message,
			result.ok ? 'success' : 'error'
		);
		await refreshAll();
	}

	async function deny(): Promise<void> {
		busy = true;
		const result = await apiRequest({
			method: 'POST',
			url: resolve('/api/approvals/clean-ups/[id=uuid]/deny', { id: view.requestId }),
			body: { note: note.trim() },
			reply: cleanupDecidedReplySchema
		});
		busy = false;
		showToast(
			result.ok ? 'Denied. Nothing was deleted; the assistant is told.' : result.message,
			result.ok ? 'success' : 'error'
		);
		await refreshAll();
	}
</script>

{#snippet itemRow(item: CleanupItemSize)}
	<ListRow action={{ kind: 'static' }} align="start" dimmed={false}>
		<span class="item">
			<span class="label">{CLEANUP_CATALOGUE[item.id].label}</span>
			<span class="size">{sizeText(item.size)}</span>
			<span class="meta">{CLEANUP_CATALOGUE[item.id].explanation}</span>
		</span>
	</ListRow>
{/snippet}

<LoadingVeil active={busy} title="Sending your decision" detail={undefined}>
	<div class="card">
		<Panel heading={undefined} actions={undefined} tone="normal" padding="normal">
			<div class="band">
				<h2 class="machine">
					<OsIcon family={view.machine.osFamily} size={20} />
					<span>{view.machine.name}</span>
				</h2>
				<p class="facts">
					<span class="chip" class:quiet={!view.machine.online}
						>{view.machine.online ? 'Online' : 'Offline now'}</span
					>
					<span class="chip strong">Deletes as {runsAs}</span>
				</p>
			</div>
			<p class="who">
				<IconRobot size={16} stroke={1.75} />
				<span
					>{view.requestedBy} via {view.assistant} ({view.verified
						? 'verified'
						: 'unverified'})</span
				>
			</p>
			<p class="meta">
				Asked {new Date(view.requestedIso).toLocaleString('en-AU')}{view.state.kind === 'pending'
					? ` · ${remainingText}`
					: ''}
			</p>
			{#if view.reason !== ''}
				<figure class="reason">
					<figcaption>{view.assistant} says:</figcaption>
					<blockquote>{view.reason}</blockquote>
				</figure>
			{/if}
		</Panel>

		<ListCard
			heading="What it cleans up"
			actions={undefined}
			label="Items to clean up, with their size when asked"
			items={view.items}
			key={(item: CleanupItemSize) => item.id}
			row={itemRow}
			empty="No items."
		/>
		<p class="total">
			Total when asked: {totalText(view.items)}. Only items from BMuster's fixed safe list; files in
			use are skipped. The files are deleted for good.
		</p>

		{#if view.state.kind === 'approved'}
			<Notice tone="info" title="Approved by {view.state.by}">
				<p>
					The clean-up runs on the machine. Its progress and results are on the
					<a href={resolve('/(console)/machines/[id]/storage', { id: view.machine.id })}
						>Storage tab</a
					>.
				</p>
			</Notice>
		{:else if view.state.kind === 'denied'}
			<Notice tone="info" title="Denied by {view.state.by}">
				<p>Nothing was deleted.{view.state.note === '' ? '' : ` Note: ${view.state.note}`}</p>
			</Notice>
		{:else if view.state.kind === 'expired'}
			<Notice tone="info" title="Expired">
				<p>Nobody decided within 10 minutes. Nothing was deleted.</p>
			</Notice>
		{:else if view.state.kind === 'cancelled'}
			<Notice tone="info" title="Withdrawn">
				<p>The assistant was disconnected. Nothing was deleted.</p>
			</Notice>
		{:else if decide?.kind === 'no'}
			<Notice tone="info" title="You cannot approve this">
				<p>{decide.why}</p>
			</Notice>
		{:else if decide?.signIn.kind === 'sign-in-again'}
			<Notice tone="info" title="Sign in again to approve">
				<p>
					You signed in more than 10 minutes ago through a provider. Sign out and in again, then
					approve it.
				</p>
			</Notice>
		{/if}

		{#if view.state.kind === 'pending'}
			{#if denying}
				<TextField
					label="Note for the assistant (optional)"
					name="note"
					type="multiline"
					autocomplete="off"
					autocapitalize="sentences"
					required={false}
					error={undefined}
					bind:value={note}
				/>
			{/if}
			<div class="room" aria-hidden="true"></div>
			<div class="bar" role="group" aria-label="Decide">
				{#if denying}
					<Button variant="secondary" size="compact" type="button" onclick={() => (denying = false)}
						>Back</Button
					>
					<Button variant="danger" size="compact" type="button" onclick={() => void deny()}
						>Deny request</Button
					>
				{:else}
					<Button variant="danger" size="compact" type="button" onclick={() => (denying = true)}
						>Deny</Button
					>
					{#if canApprove}
						<Button
							variant="primary"
							size="compact"
							type="button"
							onclick={armed ? () => void approve() : undefined}>Approve</Button
						>
					{/if}
				{/if}
			</div>
		{/if}
	</div>
</LoadingVeil>

<style>
	.card,
	.band {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: var(--space-3);
	}

	.card {
		gap: var(--gap-section);
	}

	.machine {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		font-size: var(--text-xl);
		font-weight: var(--weight-bold);
		overflow-wrap: anywhere;
	}

	.facts {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-2);
	}

	.chip {
		padding: var(--space-0-5) var(--space-2);
		border-radius: var(--radius-pill);
		background: var(--surface-muted);
		color: var(--success);
		font-size: var(--text-xs);
		font-weight: var(--weight-medium);
	}

	.chip.quiet {
		color: var(--muted);
	}

	.chip.strong {
		background: var(--warning-bg);
		color: var(--warning);
	}

	.who {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		margin-top: var(--space-3);
		font-weight: var(--weight-semibold);
		overflow-wrap: anywhere;
	}

	.meta {
		color: var(--muted);
		font-size: var(--text-xs);
		overflow-wrap: anywhere;
	}

	.reason {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: var(--space-1);
		margin: var(--space-3) 0 0;
	}

	figcaption {
		overflow-wrap: anywhere;
		color: var(--text-soft);
		font-size: var(--text-sm);
		font-weight: var(--weight-semibold);
	}

	blockquote {
		margin: 0;
		padding: var(--space-2) var(--space-3);
		border-left: 2px solid var(--border);
		color: var(--text-soft);
		font-style: italic;
		overflow-wrap: anywhere;
	}

	.item {
		display: grid;
		gap: var(--space-1);
		flex: 1;
		min-width: 0;
	}

	.label {
		font-weight: var(--weight-semibold);
		overflow-wrap: anywhere;
	}

	.size {
		font-size: var(--text-sm);
	}

	.total {
		font-size: var(--text-sm);
		overflow-wrap: anywhere;
	}

	.room {
		height: 72px;
	}

	.bar {
		position: fixed;
		right: calc(var(--page-gutter) + var(--safe-right));
		bottom: calc(var(--tabbar-height) + var(--space-3) + var(--safe-bottom));
		left: calc(var(--page-gutter) + var(--safe-left));
		z-index: 20;
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-2);
		padding: var(--space-2) var(--space-3);
		border: 1px solid var(--border);
		border-radius: var(--radius-pill);
		background: var(--surface-overlay);
		box-shadow: var(--shadow-bar);
	}

	@media (min-width: 900px) {
		.bar {
			bottom: calc(var(--space-4) + var(--safe-bottom));
			left: calc(var(--sidebar-width) + var(--page-gutter) + var(--safe-left));
		}
	}
</style>

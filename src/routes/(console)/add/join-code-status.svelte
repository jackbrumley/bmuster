<script lang="ts">
	import { resolve } from '$app/paths';
	import { IconRefresh } from '@tabler/icons-svelte-runes';
	import {
		joinCodeStatusReplySchema,
		type JoinCodeStatusReply
	} from '#lib/schemas/machines/join-codes.ts';
	import Button from '#lib/ui/button.svelte';
	import { apiRequest } from '#lib/utils/api-client.ts';

	/**
	 * What has happened to a join code, live: waiting, used by which machine,
	 * how many of a roll-out code's machines joined, or expired. Polls every 3
	 * seconds while the page is visible and the code can still change.
	 */
	let {
		codeId,
		mode
	}: {
		codeId: string;
		/** A single-use code offers a new one when it expires unused. */
		mode: { kind: 'single'; onNewCode: () => void } | { kind: 'rollout' };
	} = $props();

	const POLL_MS = 3000;
	const NAMES_SHOWN = 5;

	type View =
		| { kind: 'checking' }
		| { kind: 'known'; status: JoinCodeStatusReply }
		| { kind: 'failed'; message: string };

	let view = $state<View>({ kind: 'checking' });

	// A timer is an outside system: restart it for each code, stop it when the code is
	// used up or expired, and on unmount.
	$effect(() => {
		const id = codeId;
		let stopped = false;
		let timer: ReturnType<typeof setTimeout> | null = null;
		async function poll(): Promise<void> {
			if (document.visibilityState === 'visible') {
				const result = await apiRequest({
					method: 'GET',
					url: `/api/join-codes/${id}`,
					body: undefined,
					reply: joinCodeStatusReplySchema
				});
				if (stopped) {
					return;
				}
				if (result.ok) {
					view = { kind: 'known', status: result.data };
					if (result.data.state !== 'open') {
						return;
					}
				} else if (view.kind !== 'known') {
					view = { kind: 'failed', message: result.message };
				}
			}
			timer = setTimeout(() => {
				void poll();
			}, POLL_MS);
		}
		view = { kind: 'checking' };
		void poll();
		return () => {
			stopped = true;
			if (timer !== null) {
				clearTimeout(timer);
			}
		};
	});

	/** The time alone today; the date as well on any other day. */
	function when(iso: string): string {
		const date = new Date(iso);
		return date.toDateString() === new Date().toDateString()
			? date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
			: date.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
	}
</script>

{#snippet machineName(machine: JoinCodeStatusReply['machines'][number])}
	{#if machine.removed}
		<span class="removed">{machine.name} (removed)</span>
	{:else}
		<a href={resolve('/(console)/machines/[id]', { id: machine.id })}>{machine.name}</a>
	{/if}
{/snippet}

<div class="status" aria-live="polite">
	{#if view.kind === 'checking'}
		<p class="hint">Checking the code…</p>
	{:else if view.kind === 'failed'}
		<p class="error">{view.message}</p>
	{:else if mode.kind === 'single'}
		{@const status = view.status}
		{@const machine = status.machines[0]}
		{#if machine !== undefined}
			<p class="used">
				Used by {@render machineName(machine)} at {when(machine.enrolledAtIso)}.
			</p>
		{:else if status.state === 'expired'}
			<p class="hint">Expired at {when(status.expiresAtIso)}. Nothing joined with it.</p>
			<div>
				<Button variant="secondary" size="compact" type="button" onclick={mode.onNewCode}>
					<IconRefresh size={18} /> Make a new code
				</Button>
			</div>
		{:else if status.state === 'used-up'}
			<p class="hint">Used.</p>
		{:else}
			<p class="hint waiting">Waiting for a machine to join…</p>
		{/if}
	{:else}
		{@const status = view.status}
		<p class="count">{status.uses} of {status.maxUses} machines joined</p>
		{#if status.state === 'expired'}
			<p class="hint">Expired at {when(status.expiresAtIso)}.</p>
		{/if}
		{#if status.machines.length > 0}
			<ul class="names" aria-label="Machines that joined, newest first">
				{#each status.machines.slice(0, NAMES_SHOWN) as machine (machine.id)}
					<li>{@render machineName(machine)}</li>
				{/each}
				{#if status.machines.length > NAMES_SHOWN}
					<li>and {status.machines.length - NAMES_SHOWN} more</li>
				{/if}
			</ul>
		{/if}
	{/if}
</div>

<style>
	.status {
		display: grid;
		gap: var(--space-2);
		overflow-wrap: anywhere;
	}

	.hint {
		color: var(--muted);
		font-size: var(--text-xs);
	}

	.names {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-1) var(--space-3);
		margin: 0;
		padding: 0;
		list-style: none;
		color: var(--muted);
		font-size: var(--text-sm);
	}

	.used,
	.count {
		font-size: var(--text-sm);
		font-weight: var(--weight-medium);
	}

	.used {
		color: var(--success);
	}

	a {
		color: var(--brand);
		font-weight: var(--weight-semibold);
	}

	.removed {
		color: var(--muted);
	}

	.error {
		color: var(--danger);
		font-size: var(--text-sm);
	}
</style>

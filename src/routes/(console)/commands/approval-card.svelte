<script lang="ts">
	import { onMount } from 'svelte';
	import { refreshAll } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { IconAlertTriangle, IconRobot } from '@tabler/icons-svelte-runes';
	import {
		ASSISTANT_RUN_LIMITS,
		commandPieces,
		commandWarnings,
		hasBidiControls,
		markedCount,
		type ApprovalMachine,
		type ApprovalView
	} from '#lib/domain/commands/assistant-runs.ts';
	import { commandShellLabel } from '#lib/domain/commands/commands.ts';
	import { decidedReplySchema } from '#lib/schemas/commands/approvals.ts';
	import { commandScriptSchema } from '#lib/schemas/commands/commands.ts';
	import Button from '#lib/ui/button.svelte';
	import ChipGroup from '#lib/ui/chip-group.svelte';
	import { confirmWithChecks } from '#lib/ui/confirm-action.svelte.ts';
	import LoadingVeil from '#lib/ui/loading-veil.svelte';
	import Notice from '#lib/ui/notice.svelte';
	import OsIcon from '#lib/ui/os-icon.svelte';
	import Panel from '#lib/ui/panel.svelte';
	import TextField from '#lib/ui/text-field.svelte';
	import { showToast } from '#lib/ui/toast.svelte.ts';
	import { apiRequest } from '#lib/utils/api-client.ts';

	/**
	 * An AI assistant's request, as the person who decides it reads it (SPEC-MCP 11.1, M25): the
	 * machines and shell in a band above the command, who asked and through which assistant, the
	 * assistant's reason as its own words, and the exact command in full with every invisible or
	 * unusual character made visible. Approve stays disabled for 2 s after the card appears or
	 * changes, so it is read before it is pressed. Approve, Edit and Deny sit in a bar fixed to
	 * the bottom of the screen.
	 */
	let { view, now }: { view: ApprovalView; now: number } = $props();

	type Mode = 'read' | 'edit' | 'deny';

	let mode = $state<Mode>('read');
	let draft = $state('');
	let limit = $state('');
	let note = $state('');
	let error = $state<string | undefined>(undefined);
	let busy = $state(false);
	let armed = $state(false);
	let elapsed = $state(0);

	const shown = $derived(mode === 'edit' ? draft : view.command);
	const shownLimit = $derived(mode === 'edit' ? Number(limit) : view.timeoutMs);
	const pieces = $derived(commandPieces(shown));
	const marked = $derived(markedCount(pieces));
	const warnings = $derived(commandWarnings(shown));
	const lines = $derived(shown.split('\n').length);
	const characters = $derived(Array.from(shown).length);
	const runsAs = $derived(view.osFamily === 'windows' ? 'SYSTEM' : 'root');
	const count = $derived(view.machines.length);

	/** What would run; Approve is re-armed whenever it changes (M25). */
	const armKey = $derived(`${String(shownLimit)} ${shown}`);

	$effect(() => {
		const key = armKey;
		armed = false;
		const timer = setTimeout(() => {
			armed = armKey === key;
		}, ASSISTANT_RUN_LIMITS.approveDelayMs);
		return () => {
			clearTimeout(timer);
		};
	});

	onMount(() => {
		const tick = setInterval(() => {
			elapsed += 1000;
		}, 1000);
		return () => {
			clearInterval(tick);
		};
	});

	const remaining = $derived(Math.max(0, Date.parse(view.expiresIso) - (now + elapsed)));
	const remainingText = $derived(
		remaining === 0
			? 'Expired'
			: `Expires in ${String(Math.floor(remaining / 60_000))}:${String(Math.floor((remaining % 60_000) / 1000)).padStart(2, '0')}`
	);

	const LIMITS = [10_000, 30_000, 60_000, 120_000, 300_000, 600_000];
	const limitOptions = $derived(
		[...new Set([...LIMITS, view.timeoutMs])]
			.sort((a, b) => a - b)
			.map((ms) => ({ value: String(ms), label: limitText(ms), count: undefined }))
	);

	function limitText(ms: number): string {
		return ms < 60_000
			? `${String(ms / 1000)} s`
			: ms === 60_000
				? '60 s'
				: `${String(ms / 60_000)} min`;
	}

	function planText(plan: ApprovalMachine['plan']): string {
		switch (plan) {
			case 'runs':
				return 'Online';
			case 'offline':
				return 'Offline now';
			case 'agent-too-old':
				return 'Agent too old: skipped';
		}
	}

	function startEdit(): void {
		draft = view.command;
		limit = String(view.timeoutMs);
		error = undefined;
		mode = 'edit';
	}

	const edited = $derived(
		mode === 'edit' && (draft !== view.command || shownLimit !== view.timeoutMs)
	);

	async function approve(): Promise<void> {
		const parsed = commandScriptSchema.safeParse({
			osFamily: view.osFamily,
			shell: view.shell,
			command: shown
		});
		if (!parsed.success) {
			error = parsed.error.issues[0]?.message;
			return;
		}
		if (hasBidiControls(shown)) {
			error = 'The command has text-direction control characters. Remove them.';
			return;
		}
		if (view.decide.kind !== 'yes') {
			return;
		}
		const answer = await confirmWithChecks({
			title: `Run on ${String(count)} ${count === 1 ? 'machine' : 'machines'}?`,
			message: edited
				? `Before: ${view.command} (${limitText(view.timeoutMs)}). After: ${shown} (${limitText(shownLimit)}). It runs as ${runsAs}.`
				: `${shown}. It runs as ${runsAs}, time limit ${limitText(shownLimit)}.`,
			confirmLabel: 'Approve and run',
			typedCount: null,
			askPassword: view.decide.signIn.kind === 'password'
		});
		if (answer.kind === 'no') {
			return;
		}
		busy = true;
		const result = await apiRequest({
			method: 'POST',
			url: resolve('/api/commands/runs/[id=uuid]/approve', { id: view.runId }),
			body: {
				command: shown,
				timeoutMs: shownLimit,
				confirmCount: count,
				password:
					answer.password === '' ? { kind: 'none' } : { kind: 'given', password: answer.password }
			},
			reply: decidedReplySchema
		});
		busy = false;
		showToast(
			result.ok ? 'Approved. It is running now.' : result.message,
			result.ok ? 'success' : 'error'
		);
		await refreshAll();
	}

	async function deny(): Promise<void> {
		busy = true;
		const result = await apiRequest({
			method: 'POST',
			url: resolve('/api/commands/runs/[id=uuid]/deny', { id: view.runId }),
			body: { note: note.trim() },
			reply: decidedReplySchema
		});
		busy = false;
		showToast(
			result.ok ? 'Denied. Nothing ran; the assistant is told.' : result.message,
			result.ok ? 'success' : 'error'
		);
		await refreshAll();
	}

	const canApprove = $derived(
		view.decide.kind === 'yes' && view.decide.signIn.kind !== 'sign-in-again' && remaining > 0
	);
</script>

<LoadingVeil active={busy} title="Sending your decision" detail={undefined}>
	<div class="card">
		<Panel heading={undefined} actions={undefined} tone="normal" padding="normal">
			<div class="band">
				<h2 class="machines">{view.machines.map((machine) => machine.name).join(', ')}</h2>
				<ul class="machine-list" aria-label="Machines">
					{#each view.machines as machine (machine.id)}
						<li class="machine">
							<OsIcon family={view.osFamily} size={16} />
							<span class="name">{machine.name}</span>
							<span class="plan" class:quiet={machine.plan !== 'runs'}
								>{planText(machine.plan)}</span
							>
						</li>
					{/each}
				</ul>
				<p class="facts">
					<span class="chip">{commandShellLabel(view.shell)}</span>
					<span class="chip">time limit {limitText(shownLimit)}</span>
					<span class="chip strong">Runs as {runsAs}</span>
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
				Asked {new Date(view.requestedIso).toLocaleString('en-AU')} · {remainingText}
			</p>
			<figure class="reason">
				<figcaption>{view.assistant} says:</figcaption>
				<blockquote>{view.reason}</blockquote>
			</figure>
		</Panel>

		<Panel heading="The command" actions={undefined} tone="normal" padding="normal">
			<div class="command-block">
				<pre
					class="command"
					data-testid="command">{#each pieces as piece, index (index)}{#if piece.kind === 'text'}{piece.text}{:else if piece.kind === 'marker'}<span
								class="marker">{piece.label}</span
							>{:else}<mark class="unusual" title={piece.label}>{piece.text}</mark
							>{/if}{/each}</pre>
				<p class="meta">
					{lines}
					{lines === 1 ? 'line' : 'lines'} · {characters.toLocaleString('en-AU')} characters
				</p>
				{#if marked > 0}
					<Notice tone="warning" title="{marked} hidden or unusual characters are marked">
						<p>They are shown in boxes or highlighted. Approve only if you expected them.</p>
					</Notice>
				{/if}
				{#if warnings.length > 0}
					<ul class="warnings" aria-label="Things to check">
						{#each warnings as warning (warning)}
							<li><IconAlertTriangle size={16} stroke={1.75} /> {warning}</li>
						{/each}
					</ul>
				{/if}
				{#if mode === 'edit'}
					<TextField
						label="Command to approve"
						name="command"
						type="code"
						autocomplete="off"
						autocapitalize="off"
						required={true}
						{error}
						bind:value={draft}
					/>
					<ChipGroup label="Time limit" options={limitOptions} bind:value={limit} />
				{/if}
				{#if mode === 'deny'}
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
			</div>
		</Panel>

		{#if view.decide.kind === 'no'}
			<Notice tone="info" title="You cannot approve this">
				<p>{view.decide.why}</p>
			</Notice>
		{:else if view.decide.signIn.kind === 'sign-in-again'}
			<Notice tone="info" title="Sign in again to approve">
				<p>
					You signed in more than 10 minutes ago through a provider. Sign out and in again, then
					approve it.
				</p>
			</Notice>
		{/if}

		<div class="room" aria-hidden="true"></div>
		<div class="bar" role="group" aria-label="Decide">
			{#if mode === 'deny'}
				<Button variant="secondary" size="compact" type="button" onclick={() => (mode = 'read')}
					>Back</Button
				>
				<Button variant="danger" size="compact" type="button" onclick={() => void deny()}
					>Deny request</Button
				>
			{:else if mode === 'edit'}
				<Button variant="secondary" size="compact" type="button" onclick={() => (mode = 'read')}
					>Cancel edit</Button
				>
				{#if canApprove}
					<Button
						variant="primary"
						size="compact"
						type="button"
						onclick={armed ? () => void approve() : undefined}>Approve edited</Button
					>
				{/if}
			{:else}
				<Button variant="danger" size="compact" type="button" onclick={() => (mode = 'deny')}
					>Deny</Button
				>
				<span class="right">
					{#if canApprove}
						<Button variant="secondary" size="compact" type="button" onclick={startEdit}
							>Edit</Button
						>
						<Button
							variant="primary"
							size="compact"
							type="button"
							onclick={armed ? () => void approve() : undefined}>Approve</Button
						>
					{/if}
				</span>
			{/if}
		</div>
	</div>
</LoadingVeil>

<style>
	.card,
	.band,
	.command-block {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: var(--space-3);
	}

	.card {
		gap: var(--gap-section);
	}

	.machines {
		font-size: var(--text-xl);
		font-weight: var(--weight-bold);
		overflow-wrap: anywhere;
	}

	.machine-list {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-2) var(--space-4);
	}

	.machine {
		display: inline-flex;
		align-items: center;
		gap: var(--space-1);
		min-width: 0;
		font-size: var(--text-sm);
	}

	.name {
		font-weight: var(--weight-semibold);
		overflow-wrap: anywhere;
	}

	.plan {
		color: var(--success);
		font-size: var(--text-xs);
	}

	.plan.quiet {
		color: var(--muted);
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
		font-size: var(--text-xs);
		font-weight: var(--weight-medium);
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

	.command {
		margin: 0;
		padding: var(--space-3);
		border-radius: var(--radius-inner);
		background: var(--surface-muted);
		font-family: var(--font-mono);
		font-size: var(--text-sm);
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}

	.marker {
		margin: 0 var(--space-0-5);
		padding: 0 var(--space-1);
		border: 1px solid var(--warning);
		border-radius: var(--radius-inner);
		color: var(--warning);
		font-family: var(--font-body);
		font-size: var(--text-xs);
	}

	.unusual {
		background: var(--warning-bg);
		color: var(--warning);
		text-decoration: underline wavy;
	}

	.warnings {
		display: grid;
		gap: var(--space-1);
		color: var(--warning);
		font-size: var(--text-sm);
	}

	.warnings li {
		display: flex;
		align-items: flex-start;
		gap: var(--space-2);
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

	.right {
		display: flex;
		gap: var(--space-2);
		margin-left: auto;
	}

	@media (min-width: 900px) {
		.bar {
			bottom: calc(var(--space-4) + var(--safe-bottom));
			left: calc(var(--sidebar-width) + var(--page-gutter) + var(--safe-left));
		}
	}
</style>

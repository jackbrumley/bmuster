<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { recheckAsk, type SignInCheck } from '#lib/domain/auth/sign-in-check.ts';
	import {
		COMMAND_LIMITS,
		COMMAND_OS_FAMILIES,
		COMMAND_SHELLS,
		commandOsLabel,
		commandShellLabel,
		firstLine,
		skipReasonLabel,
		type CommandDraft,
		type CommandOsFamily,
		type CommandScript,
		type CommandShell,
		type PlannedMachine
	} from '#lib/domain/commands/commands.ts';
	import {
		commandScriptSchema,
		planReplySchema,
		startRunReplySchema
	} from '#lib/schemas/commands/commands.ts';
	import Button from '#lib/ui/button.svelte';
	import ChipGroup from '#lib/ui/chip-group.svelte';
	import { confirmWithChecks } from '#lib/ui/confirm-action.svelte.ts';
	import ListCard from '#lib/ui/list-card.svelte';
	import ListRow from '#lib/ui/list-row.svelte';
	import LoadingVeil from '#lib/ui/loading-veil.svelte';
	import Notice from '#lib/ui/notice.svelte';
	import Panel from '#lib/ui/panel.svelte';
	import TextField from '#lib/ui/text-field.svelte';
	import { showToast } from '#lib/ui/toast.svelte.ts';
	import { apiRequest } from '#lib/utils/api-client.ts';

	/**
	 * Write the command for each system in the selection (C6), then Review it (C8) and confirm
	 * (C9, C10). The machines are planned by the server first: which run, which are skipped and
	 * why, and whether the password is needed. Nothing runs before the confirmation.
	 */
	let { draft }: { draft: CommandDraft } = $props();

	type Plan =
		| { kind: 'loading' }
		| { kind: 'failed'; message: string }
		| { kind: 'ready'; machines: PlannedMachine[]; signIn: SignInCheck };

	let plan = $state<Plan>({ kind: 'loading' });
	let step = $state<'write' | 'review'>('write');
	let running = $state(false);

	onMount(() => {
		void (async () => {
			const result = await apiRequest({
				method: 'POST',
				url: resolve('/api/commands/plan'),
				body: { machineIds: draft.machineIds },
				reply: planReplySchema
			});
			plan = result.ok
				? { kind: 'ready', machines: result.data.machines, signIn: result.data.signIn }
				: { kind: 'failed', message: result.message };
		})();
	});

	const machines = $derived(plan.kind === 'ready' ? plan.machines : []);

	/** Machines the person may run on: the rest are shown as skipped and never sent (C12). */
	const sendable = $derived(
		machines.filter(
			(machine) => !(machine.plan.kind === 'skipped' && machine.plan.reason === 'no-permission')
		)
	);

	/** The systems that need a command: every Windows or Linux machine that may be sent. */
	const systems = $derived(
		COMMAND_OS_FAMILIES.filter((family) => sendable.some((machine) => machine.osFamily === family))
	);

	function countOf(family: CommandOsFamily): number {
		return sendable.filter((machine) => machine.osFamily === family).length;
	}

	function machinesText(count: number): string {
		return `${count} ${count === 1 ? 'machine' : 'machines'}`;
	}

	/** The form starts from the draft (running again fills in the commands), then is the person's. */
	const seed = untrack(() => draft);
	const seeded = (family: CommandOsFamily) =>
		seed.scripts.find((script) => script.osFamily === family);
	const commands = $state<Record<CommandOsFamily, string>>({
		windows: seeded('windows')?.command ?? '',
		linux: seeded('linux')?.command ?? ''
	});
	const shells = $state<Record<CommandOsFamily, CommandShell>>({
		windows: seeded('windows')?.shell ?? 'powershell',
		linux: seeded('linux')?.shell ?? 'sh'
	});
	const errors = $state<Record<CommandOsFamily, string | undefined>>({
		windows: undefined,
		linux: undefined
	});

	function shellOptions(family: CommandOsFamily) {
		return COMMAND_SHELLS[family].map((shell) => ({
			value: shell,
			label: commandShellLabel(shell),
			count: undefined
		}));
	}

	const LIMITS = [10_000, 30_000, 60_000, 120_000, 300_000, 600_000];
	let timeout = $state(String(seed.timeoutMs));
	const timeoutOptions = $derived(
		[...new Set([...LIMITS, seed.timeoutMs])]
			.sort((a, b) => a - b)
			.map((ms) => ({ value: String(ms), label: limitText(ms), count: undefined }))
	);

	function limitText(ms: number): string {
		return ms < 60_000 ? `${ms / 1000} s` : ms === 60_000 ? '60 s' : `${ms / 60_000} min`;
	}

	/** The commands as the server will get them, or undefined with each problem under its box. */
	function scripts(): CommandScript[] | undefined {
		const checked = systems.map((family) => {
			const parsed = commandScriptSchema.safeParse({
				osFamily: family,
				shell: shells[family],
				command: commands[family]
			});
			errors[family] = parsed.success ? undefined : parsed.error.issues[0]?.message;
			return parsed;
		});
		const valid = checked.flatMap((parsed) => (parsed.success ? [parsed.data] : []));
		return valid.length === checked.length ? valid : undefined;
	}

	const reviewed = $derived(
		step === 'review'
			? systems.map((family) => ({
					osFamily: family,
					shell: shells[family],
					command: commands[family]
				}))
			: []
	);
	const willRun = $derived(machines.filter((machine) => machine.plan.kind === 'runs'));
	const skipped = $derived(machines.filter((machine) => machine.plan.kind === 'skipped'));

	function review(): void {
		if (scripts() !== undefined) {
			step = 'review';
		}
	}

	async function run(): Promise<void> {
		const ready = scripts();
		if (ready === undefined || plan.kind !== 'ready' || plan.signIn.kind === 'sign-in-again') {
			return;
		}
		const count = sendable.length;
		const answer = await confirmWithChecks({
			title: `Run on ${count} ${count === 1 ? 'machine' : 'machines'}?`,
			message: `${ready.map((script) => `${commandOsLabel(script.osFamily)}: ${firstLine(script.command)}`).join(' · ')}. It runs as Administrator (root or SYSTEM).`,
			confirmLabel: 'Run',
			typedCount: count > COMMAND_LIMITS.typedCountAbove ? count : null,
			recheck: recheckAsk(plan.signIn)
		});
		if (answer.kind === 'no') {
			return;
		}
		running = true;
		const result = await apiRequest({
			method: 'POST',
			url: resolve('/api/commands/runs'),
			body: {
				machineIds: sendable.map((machine) => machine.id),
				scripts: ready,
				timeoutMs: Number(timeout),
				confirmCount: count,
				recheck: answer.recheck,
				rerunOf: draft.rerunOf
			},
			reply: startRunReplySchema
		});
		running = false;
		if (!result.ok) {
			showToast(result.message, 'error');
			return;
		}
		void goto(resolve('/(console)/commands/[id=uuid]', { id: result.data.runId }));
	}
</script>

<LoadingVeil active={plan.kind === 'loading'} title="Checking the machines" detail={undefined}>
	{#if plan.kind === 'failed'}
		<Notice tone="danger" title="The machines could not be checked">
			<p>{plan.message}</p>
		</Notice>
	{:else if step === 'write'}
		<div class="write">
			{#if plan.kind === 'ready' && systems.length === 0}
				<Notice tone="warning" title="None of these machines can run a command">
					<p>Commands run on Windows and Linux machines you may run commands on.</p>
				</Notice>
			{/if}
			{#each systems as family (family)}
				<Panel heading={commandOsLabel(family)} actions={undefined} tone="normal" padding="normal">
					<div class="system">
						<ChipGroup
							label="{commandOsLabel(family)} shell"
							options={shellOptions(family)}
							bind:value={
								() => shells[family],
								(next: CommandShell | null) => {
									if (next !== null) shells[family] = next;
								}
							}
						/>
						<TextField
							label="{commandOsLabel(family)} command ({machinesText(countOf(family))})"
							name="command-{family}"
							type="code"
							autocomplete="off"
							autocapitalize="off"
							required={true}
							error={errors[family]}
							bind:value={commands[family]}
						/>
					</div>
				</Panel>
			{/each}
			<Panel heading="Time limit" actions={undefined} tone="normal" padding="normal">
				<ChipGroup label="Time limit" options={timeoutOptions} bind:value={timeout} />
			</Panel>
			<div class="actions">
				<Button variant="primary" size="compact" type="button" onclick={review}>Review</Button>
			</div>
		</div>
	{:else}
		<div class="review">
			{#each reviewed as script (script.osFamily)}
				<Panel heading={undefined} actions={undefined} tone="normal" padding="normal">
					<div class="script">
						<p class="shell">
							{commandOsLabel(script.osFamily)} · {commandShellLabel(script.shell)}
						</p>
						<pre class="command">{script.command}</pre>
					</div>
				</Panel>
			{/each}
			<p class="limit">Time limit: {limitText(Number(timeout))}</p>

			<ListCard
				heading="Will run ({willRun.length})"
				actions={undefined}
				label="Will run"
				items={willRun}
				key={(machine: PlannedMachine) => machine.id}
				empty="No machine will run it now."
			>
				{#snippet row(machine: PlannedMachine)}
					<ListRow action={{ kind: 'static' }} align="center" dimmed={false}>
						<span class="name">{machine.name}</span>
					</ListRow>
				{/snippet}
			</ListCard>

			{#if skipped.length > 0}
				<ListCard
					heading="Will be skipped ({skipped.length})"
					actions={undefined}
					label="Will be skipped"
					items={skipped}
					key={(machine: PlannedMachine) => machine.id}
					empty=""
				>
					{#snippet row(machine: PlannedMachine)}
						<ListRow action={{ kind: 'static' }} align="center" dimmed={true}>
							<span class="name">{machine.name}</span>
							<span class="reason">
								{machine.plan.kind === 'skipped' ? skipReasonLabel(machine.plan.reason) : ''}
							</span>
						</ListRow>
					{/snippet}
				</ListCard>
			{/if}

			{#if plan.kind === 'ready' && plan.signIn.kind === 'sign-in-again'}
				<Notice tone="warning" title="Sign in again to run commands">
					<p>You signed in more than 10 minutes ago. Sign out and sign in again, then run it.</p>
				</Notice>
			{/if}

			<div class="actions">
				<Button
					variant="secondary"
					size="compact"
					type="button"
					onclick={() => {
						step = 'write';
					}}>Back</Button
				>
				{#if plan.kind === 'ready' && plan.signIn.kind !== 'sign-in-again' && sendable.length > 0}
					<LoadingVeil active={running} title="Starting" detail={undefined}>
						<Button
							variant="danger"
							size="compact"
							type="button"
							onclick={() => {
								void run();
							}}>Run</Button
						>
					</LoadingVeil>
				{/if}
			</div>
		</div>
	{/if}
</LoadingVeil>

<style>
	.write,
	.review {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: var(--gap-section);
	}

	.system,
	.script {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: var(--space-3);
	}

	.shell,
	.limit {
		color: var(--text-soft);
		font-size: var(--text-sm);
		font-weight: var(--weight-semibold);
	}

	.command {
		margin: 0;
		padding: var(--space-3);
		overflow-x: auto;
		border-radius: var(--radius-inner);
		background: var(--surface-muted);
		font-family: var(--font-mono);
		font-size: var(--text-sm);
		white-space: pre;
	}

	.name {
		flex: 1;
		min-width: 0;
		overflow-wrap: anywhere;
	}

	.reason {
		color: var(--muted);
		font-size: var(--text-xs);
		text-align: right;
	}

	.actions {
		display: flex;
		flex-wrap: wrap;
		justify-content: flex-end;
		gap: var(--space-2);
	}
</style>

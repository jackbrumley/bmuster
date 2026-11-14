<script lang="ts">
	import { untrack } from 'svelte';
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { recheckAsk, type SignInCheck } from '#lib/domain/auth/sign-in-check.ts';
	import {
		COMMAND_LIMITS,
		commandOsLabel,
		commandShellLabel,
		type CommandScript,
		type PlannedMachine
	} from '#lib/domain/commands/commands.ts';
	import {
		parameterValueProblem,
		savedEffectLabel,
		textPatternHint,
		type ParameterValues,
		type SavedEffect,
		type SavedParameter,
		type SavedRunMachine
	} from '#lib/domain/commands/saved-commands.ts';
	import { startRunReplySchema } from '#lib/schemas/commands/commands.ts';
	import { savedPlanReplySchema } from '#lib/schemas/commands/saved-commands.ts';
	import Button from '#lib/ui/button.svelte';
	import Checkbox from '#lib/ui/checkbox.svelte';
	import ChipGroup from '#lib/ui/chip-group.svelte';
	import { confirmWithChecks } from '#lib/ui/confirm-action.svelte.ts';
	import EmptyState from '#lib/ui/empty-state.svelte';
	import LoadingVeil from '#lib/ui/loading-veil.svelte';
	import Notice from '#lib/ui/notice.svelte';
	import Panel from '#lib/ui/panel.svelte';
	import TextField from '#lib/ui/text-field.svelte';
	import { showToast } from '#lib/ui/toast.svelte.ts';
	import { apiRequest } from '#lib/utils/api-client.ts';
	import PlannedMachines from '../../../planned-machines.svelte';
	import { IconDevices } from '@tabler/icons-svelte-runes';

	/**
	 * Run a saved command (SPEC-SAVED-COMMANDS SC10, SC11): fill in its parameters (checked with the
	 * server's rules), tick the machines (only those it may run on for this person), then Review
	 * the exact commands and confirm as on Commands, with the recent sign-in check.
	 */
	let {
		command,
		machines,
		ticked
	}: {
		command: {
			id: string;
			name: string;
			description: string;
			effect: SavedEffect;
			version: number;
			parameters: SavedParameter[];
			timeoutMs: number;
		};
		machines: SavedRunMachine[];
		ticked: string[];
	} = $props();

	type Plan =
		| { kind: 'none' }
		| { kind: 'loading' }
		| {
				kind: 'ready';
				commands: CommandScript[];
				machines: PlannedMachine[];
				signIn: SignInCheck;
		  };

	const allowed = untrack(() => new Set(machines.map((machine) => machine.id)));
	let chosen = $state<string[]>(untrack(() => ticked.filter((id) => allowed.has(id))));
	const values = $state<Record<string, string>>(
		Object.fromEntries(
			untrack(() => command.parameters).map((parameter) => [
				parameter.name,
				parameter.kind === 'choice' ? (parameter.choices[0] ?? '') : ''
			])
		)
	);
	let errors = $state<Record<string, string | undefined>>({});
	let plan = $state<Plan>({ kind: 'none' });
	let running = $state(false);

	function choiceOptions(parameter: Extract<SavedParameter, { kind: 'choice' }>) {
		return parameter.choices.map((choice) => ({ value: choice, label: choice, count: undefined }));
	}

	function fieldLabel(parameter: SavedParameter): string {
		switch (parameter.kind) {
			case 'number':
				return `${parameter.label} (${String(parameter.min)} to ${String(parameter.max)})`;
			case 'choice':
				return parameter.label;
			case 'text':
				return `${parameter.label} (${textPatternHint(parameter.pattern)})`;
		}
	}

	/** The values as the server will get them, or undefined with each problem under its field. */
	function checkedValues(): ParameterValues | undefined {
		const next: Record<string, string | undefined> = {};
		for (const parameter of command.parameters) {
			next[parameter.name] = parameterValueProblem(parameter, values[parameter.name]);
		}
		next['machines'] = chosen.length === 0 ? 'Tick at least one machine.' : undefined;
		errors = next;
		return Object.values(next).every((problem) => problem === undefined)
			? { ...values }
			: undefined;
	}

	function toggle(id: string, on: boolean): void {
		chosen = on
			? [...chosen.filter((other) => other !== id), id]
			: chosen.filter((other) => other !== id);
	}

	async function review(): Promise<void> {
		const ready = checkedValues();
		if (ready === undefined) {
			return;
		}
		plan = { kind: 'loading' };
		const result = await apiRequest({
			method: 'POST',
			url: resolve('/api/commands/saved/[id=uuid]/plan', { id: command.id }),
			body: { version: command.version, machineIds: chosen, values: ready },
			reply: savedPlanReplySchema
		});
		if (!result.ok) {
			plan = { kind: 'none' };
			showToast(result.message, 'error');
			return;
		}
		plan = { kind: 'ready', ...result.data };
	}

	async function run(): Promise<void> {
		if (plan.kind !== 'ready' || plan.signIn.kind === 'sign-in-again') {
			return;
		}
		const count = chosen.length;
		const answer = await confirmWithChecks({
			title: `Run on ${String(count)} ${count === 1 ? 'machine' : 'machines'}?`,
			message: `${command.name} (${savedEffectLabel(command.effect)}). It runs as Administrator (root or SYSTEM).`,
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
			url: resolve('/api/commands/saved/[id=uuid]/runs', { id: command.id }),
			body: {
				version: command.version,
				machineIds: chosen,
				values: { ...values },
				confirmCount: count,
				recheck: answer.recheck
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

{#if machines.length === 0}
	<EmptyState
		icon={IconDevices}
		title="No machine you may run this on."
		detail="It runs on machines in its groups where you may run commands, on a system it has a script for."
		children={undefined}
	/>
{:else if plan.kind !== 'ready'}
	<LoadingVeil active={plan.kind === 'loading'} title="Checking the machines" detail={undefined}>
		<div class="steps">
			<Panel heading={undefined} actions={undefined} tone="normal" padding="normal">
				<div class="fields">
					<p class="description">{command.description}</p>
					<p class="label" class:warn={command.effect === 'changes'}>
						{savedEffectLabel(command.effect)} · version {command.version} · time limit
						{command.timeoutMs / 1000} s
					</p>
					{#each command.parameters as parameter (parameter.name)}
						{#if parameter.kind === 'choice'}
							<ChipGroup
								label={parameter.label}
								options={choiceOptions(parameter)}
								bind:value={
									() => values[parameter.name] ?? null,
									(next: string | null) => {
										if (next !== null) values[parameter.name] = next;
									}
								}
							/>
						{:else}
							<TextField
								label={fieldLabel(parameter)}
								name="value-{parameter.name}"
								type={parameter.kind === 'text' ? 'code' : 'text'}
								autocomplete="off"
								autocapitalize="off"
								required={true}
								error={errors[parameter.name]}
								bind:value={
									() => values[parameter.name] ?? '',
									(next: string) => {
										values[parameter.name] = next;
									}
								}
							/>
						{/if}
					{/each}
				</div>
			</Panel>

			<Panel
				heading="Machines ({chosen.length} ticked)"
				actions={undefined}
				tone="normal"
				padding="normal"
			>
				<div class="machines">
					<div class="select">
						<Button
							variant="secondary"
							size="compact"
							type="button"
							onclick={() => {
								chosen = machines.map((machine) => machine.id);
							}}>Select all {machines.length}</Button
						>
						{#if chosen.length > 0}
							<Button
								variant="secondary"
								size="compact"
								type="button"
								onclick={() => {
									chosen = [];
								}}>Clear</Button
							>
						{/if}
					</div>
					{#each machines as machine (machine.id)}
						<Checkbox
							label="{machine.name} ({commandOsLabel(machine.osFamily)})"
							error={undefined}
							bind:checked={
								() => chosen.includes(machine.id),
								(on: boolean) => {
									toggle(machine.id, on);
								}
							}
						/>
					{/each}
					{#if errors['machines'] !== undefined}
						<p class="error" role="alert">{errors['machines']}</p>
					{/if}
				</div>
			</Panel>

			<div class="actions">
				<Button variant="primary" size="compact" type="button" onclick={() => void review()}
					>Review</Button
				>
			</div>
		</div>
	</LoadingVeil>
{:else}
	<div class="steps">
		<p class="label" class:warn={command.effect === 'changes'}>
			{command.name} · {savedEffectLabel(command.effect)} · version {command.version}
		</p>
		{#each plan.commands as script (script.osFamily)}
			<Panel heading={undefined} actions={undefined} tone="normal" padding="normal">
				<div class="fields">
					<p class="shell">{commandOsLabel(script.osFamily)} · {commandShellLabel(script.shell)}</p>
					<pre class="command">{script.command}</pre>
				</div>
			</Panel>
		{/each}
		<p class="shell">Time limit: {command.timeoutMs / 1000} s</p>

		<PlannedMachines machines={plan.machines} />

		{#if plan.signIn.kind === 'sign-in-again'}
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
					plan = { kind: 'none' };
				}}>Back</Button
			>
			{#if plan.signIn.kind !== 'sign-in-again'}
				<LoadingVeil active={running} title="Starting" detail={undefined}>
					<Button variant="danger" size="compact" type="button" onclick={() => void run()}
						>Run</Button
					>
				</LoadingVeil>
			{/if}
		</div>
	</div>
{/if}

<style>
	.steps,
	.fields,
	.machines {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: var(--gap-section);
	}

	.fields,
	.machines {
		gap: var(--space-3);
	}

	.description {
		overflow-wrap: anywhere;
	}

	.label,
	.shell {
		color: var(--text-soft);
		font-size: var(--text-sm);
		font-weight: var(--weight-semibold);
		overflow-wrap: anywhere;
	}

	.warn {
		color: var(--warning);
	}

	.select,
	.actions {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-2);
	}

	.actions {
		justify-content: flex-end;
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

	.error {
		color: var(--danger);
		font-size: var(--text-sm);
	}
</style>

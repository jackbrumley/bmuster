<script lang="ts">
	import { untrack } from 'svelte';
	import { goto, refreshAll } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { IconPlus, IconTrash } from '@tabler/icons-svelte-runes';
	import { recheckAsk, type SignInCheck } from '#lib/domain/auth/sign-in-check.ts';
	import {
		COMMAND_OS_FAMILIES,
		COMMAND_SHELLS,
		commandOsLabel,
		commandShellLabel,
		type CommandOsFamily
	} from '#lib/domain/commands/commands.ts';
	import {
		SAVED_COMMAND_LIMITS,
		TEXT_PATTERNS,
		savedEffectLabel,
		textPatternLabel,
		type SavedCommandView,
		type SavedEffect,
		type SavedParameter,
		type TextPattern
	} from '#lib/domain/commands/saved-commands.ts';
	import {
		savedCommandDeletedSchema,
		savedCommandFieldsSchema,
		savedCommandWrittenSchema,
		type SavedCommandFields
	} from '#lib/schemas/commands/saved-commands.ts';
	import Button from '#lib/ui/button.svelte';
	import ChipGroup from '#lib/ui/chip-group.svelte';
	import {
		confirmAction,
		confirmWithChecks,
		type ConfirmAnswer
	} from '#lib/ui/confirm-action.svelte.ts';
	import Notice from '#lib/ui/notice.svelte';
	import Panel from '#lib/ui/panel.svelte';
	import SegmentedControl from '#lib/ui/segmented-control.svelte';
	import TextField from '#lib/ui/text-field.svelte';
	import ToggleChips from '#lib/ui/toggle-chips.svelte';
	import { showToast } from '#lib/ui/toast.svelte.ts';
	import { apiRequest } from '#lib/utils/api-client.ts';

	/**
	 * A saved command's form (SPEC-SAVED-COMMANDS SC2–SC6), admins only: what it is, a script per
	 * system, the machine groups, typed parameters, its label, and whether AI may run it without
	 * approval (confirmed when it changes the machine). The form and the server check it with the
	 * same schema; saving asks for the password when the sign-in is not recent (SC4).
	 */
	let {
		initial,
		groups,
		signIn
	}: {
		initial: { kind: 'new' } | { kind: 'edit'; command: SavedCommandView };
		groups: { id: string; name: string }[];
		signIn: SignInCheck;
	} = $props();

	type ShellChoice = 'none' | (typeof COMMAND_SHELLS)[CommandOsFamily][number];
	type ParameterRow = {
		key: string;
		name: string;
		label: string;
		kind: SavedParameter['kind'];
		min: string;
		max: string;
		choices: string;
		pattern: TextPattern;
	};

	const start = untrack(() => (initial.kind === 'edit' ? initial.command : undefined));
	const scriptOf = (family: CommandOsFamily) =>
		start?.scripts.find((script) => script.osFamily === family);

	let name = $state(start?.name ?? '');
	let description = $state(start?.description ?? '');
	let effect = $state<SavedEffect>(start?.effect ?? 'reads-only');
	let enabled = $state<'on' | 'off'>(start?.enabled === true ? 'on' : 'off');
	let ai = $state<'on' | 'off'>(start?.aiUnattended === true ? 'on' : 'off');
	let timeout = $state(String(start?.timeoutMs ?? 60_000));
	let groupIds = $state<string[]>(start?.machineGroupIds ?? []);
	const shells = $state<Record<CommandOsFamily, ShellChoice>>({
		windows: scriptOf('windows')?.shell ?? (start === undefined ? 'powershell' : 'none'),
		linux: scriptOf('linux')?.shell ?? (start === undefined ? 'sh' : 'none')
	});
	const scripts = $state<Record<CommandOsFamily, string>>({
		windows: scriptOf('windows')?.script ?? '',
		linux: scriptOf('linux')?.script ?? ''
	});
	let parameters = $state<ParameterRow[]>((start?.parameters ?? []).map(rowOf));
	let errors = $state<Record<string, string | undefined>>({});
	let busy = $state(false);

	function rowOf(parameter: SavedParameter): ParameterRow {
		return {
			key: crypto.randomUUID(),
			name: parameter.name,
			label: parameter.label,
			kind: parameter.kind,
			min: parameter.kind === 'number' ? String(parameter.min) : '1',
			max: parameter.kind === 'number' ? String(parameter.max) : '100',
			choices: parameter.kind === 'choice' ? parameter.choices.join('\n') : '',
			pattern: parameter.kind === 'text' ? parameter.pattern : 'word'
		};
	}

	const ON_OFF: { value: 'on' | 'off'; label: string }[] = [
		{ value: 'on', label: 'On' },
		{ value: 'off', label: 'Off' }
	];
	const EFFECTS: { value: SavedEffect; label: string }[] = [
		{ value: 'reads-only', label: savedEffectLabel('reads-only') },
		{ value: 'changes', label: savedEffectLabel('changes') }
	];
	const KINDS: { value: SavedParameter['kind']; label: string }[] = [
		{ value: 'text', label: 'Short text' },
		{ value: 'number', label: 'Whole number' },
		{ value: 'choice', label: 'Choice' }
	];
	const PATTERNS = TEXT_PATTERNS.map((pattern) => ({
		value: pattern,
		label: textPatternLabel(pattern),
		count: undefined
	}));
	const LIMITS = [10_000, 30_000, 60_000, 120_000, 300_000, 600_000];
	const timeoutOptions = [...new Set([...LIMITS, Number(untrack(() => timeout))])]
		.sort((a, b) => a - b)
		.map((ms) => ({
			value: String(ms),
			label: ms < 60_000 ? `${ms / 1000} s` : `${ms / 60_000} min`,
			count: undefined
		}));
	const groupOptions = $derived(groups.map((group) => ({ value: group.id, label: group.name })));

	function shellOptions(family: CommandOsFamily) {
		return [
			{ value: 'none' as const, label: 'No script', count: undefined },
			...COMMAND_SHELLS[family].map((shell) => ({
				value: shell,
				label: commandShellLabel(shell),
				count: undefined
			}))
		];
	}

	const AI_RISK =
		'An AI assistant will run it as Administrator with no person approving each run, on any machine in its groups where the person holds AI commands and Run commands.';

	/** SC6: letting AI run, without approval, a command that changes the machine is confirmed. */
	async function setAi(picked: 'on' | 'off' | null): Promise<void> {
		if (picked === 'on' && effect === 'changes') {
			const yes = await confirmAction({
				title: 'Let AI change machines without approval?',
				message: `${name === '' ? 'This command' : name} changes the machine. ${AI_RISK}`,
				confirmLabel: 'Let AI run it'
			});
			ai = yes ? 'on' : 'off';
			return;
		}
		ai = picked ?? ai;
	}

	async function setEffect(picked: SavedEffect | null): Promise<void> {
		if (picked === 'changes' && ai === 'on') {
			const yes = await confirmAction({
				title: 'Keep AI running it without approval?',
				message: `Labelled Changes the machine. ${AI_RISK}`,
				confirmLabel: 'Keep it on'
			});
			ai = yes ? 'on' : 'off';
		}
		effect = picked ?? effect;
	}

	function addParameter(): void {
		parameters = [
			...parameters,
			{
				key: crypto.randomUUID(),
				name: '',
				label: '',
				kind: 'text',
				min: '1',
				max: '100',
				choices: '',
				pattern: 'service-name'
			}
		];
	}

	function parameterOf(row: ParameterRow): SavedParameter {
		switch (row.kind) {
			case 'number':
				return {
					kind: 'number',
					name: row.name.trim(),
					label: row.label,
					min: Number(row.min),
					max: Number(row.max)
				};
			case 'choice':
				return {
					kind: 'choice',
					name: row.name.trim(),
					label: row.label,
					choices: row.choices
						.split('\n')
						.map((choice) => choice.trim())
						.filter((choice) => choice !== '')
				};
			case 'text':
				return { kind: 'text', name: row.name.trim(), label: row.label, pattern: row.pattern };
		}
	}

	/** The command as the server will get it, or undefined with each problem under its field. */
	function checked(): SavedCommandFields | undefined {
		const parsed = savedCommandFieldsSchema.safeParse({
			name,
			description,
			scripts: COMMAND_OS_FAMILIES.flatMap((family) => {
				const shell = shells[family];
				return shell === 'none' ? [] : [{ osFamily: family, shell, script: scripts[family] }];
			}),
			machineGroupIds: groupIds,
			parameters: parameters.map(parameterOf),
			effect,
			enabled: enabled === 'on',
			aiUnattended: ai === 'on',
			timeoutMs: Number(timeout)
		});
		const next: Record<string, string | undefined> = {};
		if (!parsed.success) {
			for (const issue of parsed.error.issues) {
				const [field, index] = issue.path;
				const key =
					field === 'scripts' && typeof index === 'number'
						? `script-${COMMAND_OS_FAMILIES.filter((family) => shells[family] !== 'none')[index] ?? 'linux'}`
						: String(field ?? 'form');
				next[key] ??= issue.message;
			}
		}
		errors = next;
		return parsed.success ? parsed.data : undefined;
	}

	/** Saving needs a recent sign-in (SC4): the password or a code only when it is not. */
	async function recheck(title: string, message: string, label: string): Promise<ConfirmAnswer> {
		const ask = recheckAsk(signIn);
		if (ask === 'none') {
			return { kind: 'yes', recheck: { kind: 'none' } };
		}
		return confirmWithChecks({
			title,
			message,
			confirmLabel: label,
			typedCount: null,
			recheck: ask
		});
	}

	async function save(): Promise<void> {
		const command = checked();
		if (command === undefined) {
			showToast('Check the fields marked below.', 'error');
			return;
		}
		const answer = await recheck(
			`Save ${command.name}?`,
			'Saving a saved command needs a recent sign-in.',
			'Save'
		);
		if (answer.kind === 'no') {
			return;
		}
		busy = true;
		const result = await apiRequest({
			method: initial.kind === 'new' ? 'POST' : 'PUT',
			url:
				initial.kind === 'new'
					? resolve('/api/commands/saved')
					: resolve('/api/commands/saved/[id=uuid]', { id: initial.command.id }),
			body: { command, recheck: answer.recheck },
			reply: savedCommandWrittenSchema
		});
		busy = false;
		if (!result.ok) {
			showToast(result.message, 'error');
			await refreshAll();
			return;
		}
		showToast(`${command.name} is saved (version ${String(result.data.version)}).`, 'success');
		await goto(resolve('/(console)/commands/saved'));
	}

	async function remove(): Promise<void> {
		if (initial.kind !== 'edit') {
			return;
		}
		const answer = await confirmWithChecks({
			title: `Delete ${initial.command.name}?`,
			message: 'Nobody can run it after this. Past runs keep its name and version.',
			confirmLabel: 'Delete',
			typedCount: null,
			recheck: recheckAsk(signIn)
		});
		if (answer.kind === 'no') {
			return;
		}
		const result = await apiRequest({
			method: 'DELETE',
			url: resolve('/api/commands/saved/[id=uuid]', { id: initial.command.id }),
			body: { recheck: answer.recheck },
			reply: savedCommandDeletedSchema
		});
		if (!result.ok) {
			showToast(result.message, 'error');
			await refreshAll();
			return;
		}
		showToast(`${initial.command.name} is deleted.`, 'success');
		await goto(resolve('/(console)/commands/saved'));
	}
</script>

<div class="form">
	{#if signIn.kind === 'sign-in-again'}
		<Notice tone="warning" title="Sign in again to save">
			<p>You signed in more than 10 minutes ago. Sign out and sign in again, then save.</p>
		</Notice>
	{/if}

	<Panel heading="What it is" actions={undefined} tone="normal" padding="normal">
		<div class="fields">
			<TextField
				label="Name"
				name="name"
				type="text"
				autocomplete="off"
				autocapitalize="sentences"
				required={true}
				error={errors['name']}
				bind:value={name}
			/>
			<TextField
				label="Description (what it does, for people and AI)"
				name="description"
				type="multiline"
				autocomplete="off"
				autocapitalize="sentences"
				required={true}
				error={errors['description']}
				bind:value={description}
			/>
			<SegmentedControl label="Label" options={EFFECTS} bind:value={() => effect, setEffect} />
			<SegmentedControl label="Switched on" options={ON_OFF} bind:value={enabled} />
			<div class:warn={ai === 'on' && effect === 'changes'}>
				<SegmentedControl
					label="AI may run this without approval"
					options={ON_OFF}
					bind:value={() => ai, setAi}
				/>
			</div>
			<ChipGroup label="Time limit" options={timeoutOptions} bind:value={timeout} />
		</div>
	</Panel>

	{#each COMMAND_OS_FAMILIES as family (family)}
		<Panel
			heading="{commandOsLabel(family)} script"
			actions={undefined}
			tone="normal"
			padding="normal"
		>
			<div class="fields">
				<ChipGroup
					label="{commandOsLabel(family)} shell"
					options={shellOptions(family)}
					bind:value={
						() => shells[family],
						(next: ShellChoice | null) => {
							if (next !== null) shells[family] = next;
						}
					}
				/>
				{#if shells[family] !== 'none'}
					<TextField
						label="{commandOsLabel(family)} script"
						name="script-{family}"
						type="code"
						autocomplete="off"
						autocapitalize="off"
						required={true}
						error={errors[`script-${family}`]}
						bind:value={scripts[family]}
					/>
				{/if}
			</div>
		</Panel>
	{/each}
	{#if errors['scripts'] !== undefined}
		<p class="error" role="alert">{errors['scripts']}</p>
	{/if}

	<Panel heading="Machine groups it may run on" actions={undefined} tone="normal" padding="normal">
		<ToggleChips label="Machine groups" options={groupOptions} bind:selected={groupIds} />
		{#if errors['machineGroupIds'] !== undefined}
			<p class="error" role="alert">{errors['machineGroupIds']}</p>
		{/if}
	</Panel>

	<Panel heading="Parameters" actions={undefined} tone="normal" padding="normal">
		<p class="hint">
			Each value reaches the scripts only as an environment variable, BMUSTER_PARAM_ and the name in
			capitals (for example $BMUSTER_PARAM_SERVICE in sh, $env:BMUSTER_PARAM_SERVICE in PowerShell),
			never as script text.
		</p>
		{#each parameters as row, index (row.key)}
			<div class="parameter">
				<TextField
					label="Name (lower case, digits and _)"
					name="parameter-name-{index}"
					type="code"
					autocomplete="off"
					autocapitalize="off"
					required={true}
					error={undefined}
					bind:value={row.name}
				/>
				<TextField
					label="Label"
					name="parameter-label-{index}"
					type="text"
					autocomplete="off"
					autocapitalize="sentences"
					required={true}
					error={undefined}
					bind:value={row.label}
				/>
				<SegmentedControl label="Type" options={KINDS} bind:value={row.kind} />
				{#if row.kind === 'number'}
					<TextField
						label="Smallest"
						name="parameter-min-{index}"
						type="text"
						autocomplete="off"
						autocapitalize="off"
						required={true}
						error={undefined}
						bind:value={row.min}
					/>
					<TextField
						label="Largest"
						name="parameter-max-{index}"
						type="text"
						autocomplete="off"
						autocapitalize="off"
						required={true}
						error={undefined}
						bind:value={row.max}
					/>
				{:else if row.kind === 'choice'}
					<TextField
						label="Choices, one per line"
						name="parameter-choices-{index}"
						type="multiline"
						autocomplete="off"
						autocapitalize="off"
						required={true}
						error={undefined}
						bind:value={row.choices}
					/>
				{:else}
					<ChipGroup label="Pattern" options={PATTERNS} bind:value={row.pattern} />
				{/if}
				<div class="row-actions">
					<Button
						variant="secondary"
						size="compact"
						type="button"
						onclick={() => {
							parameters = parameters.filter((other) => other.key !== row.key);
						}}
					>
						<IconTrash size={18} /> Remove parameter
					</Button>
				</div>
			</div>
		{/each}
		{#if errors['parameters'] !== undefined}
			<p class="error" role="alert">{errors['parameters']}</p>
		{/if}
		{#if parameters.length < SAVED_COMMAND_LIMITS.maxParameters}
			<div class="row-actions">
				<Button variant="secondary" size="compact" type="button" onclick={addParameter}>
					<IconPlus size={18} /> Add parameter
				</Button>
			</div>
		{/if}
	</Panel>

	<div class="actions">
		{#if initial.kind === 'edit'}
			<Button variant="danger" size="compact" type="button" onclick={() => void remove()}>
				<IconTrash size={18} /> Delete
			</Button>
		{/if}
		<Button
			variant="primary"
			size="compact"
			type="button"
			onclick={busy || signIn.kind === 'sign-in-again' ? undefined : () => void save()}
		>
			{busy ? 'Saving…' : 'Save'}
		</Button>
	</div>
</div>

<style>
	.form,
	.fields {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: var(--gap-section);
	}

	.fields {
		gap: var(--space-4);
	}

	.warn {
		padding: var(--space-2);
		border-radius: var(--radius-inner);
		background: var(--warning-bg);
		color: var(--warning);
	}

	.parameter {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: var(--space-3);
		padding: var(--space-3) 0;
		border-top: 1px solid var(--border);
	}

	.hint {
		color: var(--muted);
		font-size: var(--text-sm);
		overflow-wrap: anywhere;
	}

	.error {
		color: var(--danger);
		font-size: var(--text-sm);
	}

	.row-actions,
	.actions {
		display: flex;
		flex-wrap: wrap;
		justify-content: flex-end;
		gap: var(--space-2);
	}
</style>

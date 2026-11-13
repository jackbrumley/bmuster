<script lang="ts">
	import Button from './button.svelte';
	import CopyField from './copy-field.svelte';
	import TextField from './text-field.svelte';
	import { confirmation } from './confirm-action.svelte.ts';

	/** Shows the question `confirmAction()` asks. Mounted once, in the console frame. */
	let dialog = $state<HTMLDialogElement | undefined>(undefined);

	const asking = $derived(
		confirmation.current.kind === 'asking' ? confirmation.current : undefined
	);

	$effect(() => {
		if (dialog === undefined) {
			return;
		}
		if (asking !== undefined && !dialog.open) {
			dialog.showModal();
		} else if (asking === undefined && dialog.open) {
			dialog.close();
		}
	});

	let typedText = $state('');
	let typedError = $state<string | undefined>(undefined);
	let password = $state('');
	let passwordError = $state<string | undefined>(undefined);

	/** Why the typed check does not pass yet, or undefined when it does. */
	function typedProblem(): string | undefined {
		switch (asking?.typed.kind) {
			case undefined:
			case 'none':
				return undefined;
			case 'text':
				return typedText.trim() === asking.typed.text
					? undefined
					: 'Type the name exactly as shown to confirm.';
			case 'count':
				return typedText.trim() === String(asking.typed.count)
					? undefined
					: `Type ${asking.typed.count} to confirm.`;
		}
	}

	function answer(yes: boolean): void {
		if (yes) {
			typedError = typedProblem();
			passwordError =
				asking?.password.kind === 'ask' && password === '' ? 'Type your password.' : undefined;
			if (typedError !== undefined || passwordError !== undefined) {
				return;
			}
		}
		const given = password;
		typedText = '';
		typedError = undefined;
		password = '';
		passwordError = undefined;
		asking?.answer(yes ? { kind: 'yes', password: given } : { kind: 'no' });
	}
</script>

<dialog
	bind:this={dialog}
	class="confirm"
	aria-labelledby="confirm-title"
	oncancel={(event) => {
		event.preventDefault();
		answer(false);
	}}
>
	{#if asking !== undefined}
		<h2 id="confirm-title">{asking.options.title}</h2>
		<p>{asking.options.message}</p>
		{#if asking.typed.kind === 'text'}
			<div class="typed">
				<CopyField value={asking.typed.text} label="name" />
				<TextField
					label="Type the name above to confirm"
					name="confirm-name"
					type="text"
					autocomplete="off"
					autocapitalize="off"
					required={true}
					error={typedError}
					bind:value={typedText}
				/>
			</div>
		{:else if asking.typed.kind === 'count'}
			<div class="typed">
				<TextField
					label="Type {asking.typed.count}, the number of machines, to confirm"
					name="confirm-count"
					type="text"
					autocomplete="off"
					autocapitalize="off"
					required={true}
					error={typedError}
					bind:value={typedText}
				/>
			</div>
		{/if}
		{#if asking.password.kind === 'ask'}
			<div class="typed">
				<TextField
					label="Your password (you signed in more than 10 minutes ago)"
					name="confirm-password"
					type="password"
					autocomplete="current-password"
					autocapitalize="off"
					required={true}
					error={passwordError}
					bind:value={password}
				/>
			</div>
		{/if}
		<div class="actions">
			<Button
				variant="secondary"
				size="compact"
				type="button"
				onclick={() => {
					answer(false);
				}}
			>
				Cancel
			</Button>
			<Button
				variant="danger"
				size="compact"
				type="button"
				onclick={() => {
					answer(true);
				}}
			>
				{asking.options.confirmLabel}
			</Button>
		</div>
	{/if}
</dialog>

<style>
	.confirm {
		width: min(26rem, calc(100vw - 32px));
		padding: var(--space-6);
		border: 1px solid var(--border);
		border-radius: var(--radius-modal);
		background: var(--surface-overlay);
		color: var(--text);
		box-shadow: var(--shadow-popover);
	}

	.confirm::backdrop {
		background: var(--shadow-tint);
	}

	h2 {
		margin-bottom: var(--space-2);
		font-size: var(--text-lg);
		font-weight: var(--weight-bold);
	}

	p {
		margin-bottom: var(--space-6);
		color: var(--text-soft);
		font-size: var(--text-sm);
	}

	.typed {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: var(--space-2);
		margin-bottom: var(--space-6);
	}

	.actions {
		display: flex;
		justify-content: flex-end;
		gap: var(--space-2);
	}
</style>

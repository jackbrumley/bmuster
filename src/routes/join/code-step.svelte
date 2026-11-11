<script lang="ts">
	import Button from '#lib/ui/button.svelte';

	/**
	 * The first step on /join (SPEC-JOIN J5): only the organisation and a box
	 * for the six digits. Big digits and a number keypad on phones.
	 */
	let {
		organisation,
		problem,
		busy,
		submit
	}: {
		organisation: string;
		/** Why the last code was refused. */
		problem: string | undefined;
		busy: boolean;
		submit: (typed: string) => void;
	} = $props();

	let typed = $state('');
	const displayCode = $derived(
		typed.length > 3 ? `${typed.slice(0, 3)}\u2002${typed.slice(3)}` : typed
	);
	const problemId = $props.id();

	function send(event: SubmitEvent): void {
		event.preventDefault();
		if (!busy) {
			submit(typed);
		}
	}
</script>

<form class="step" onsubmit={send}>
	<h1>Add this computer to {organisation}</h1>
	<p class="intro">
		{organisation} manages its computers with BMuster. Enrolling installs the BMuster agent, so this computer
		is registered with {organisation} and managed by it.
	</p>
	<label class="field">
		<span class="label">Enrolment code</span>
		<input
			data-raw-input="code-entry"
			class="code"
			type="text"
			inputmode="numeric"
			autocomplete="one-time-code"
			maxlength="12"
			placeholder="000&#8194;000"
			aria-invalid={problem !== undefined}
			aria-describedby={problem !== undefined ? problemId : undefined}
			bind:value={
				() => displayCode,
				(value: string) => {
					typed = value.replace(/\D/g, '').slice(0, 6);
				}
			}
		/>
	</label>
	{#if problem !== undefined}
		<p class="problem" id={problemId} role="alert">{problem}</p>
	{/if}
	<p class="hint">Your IT administrator gives you the enrolment code.</p>
	<Button variant="primary" size="large" type="submit" onclick={undefined}>
		{busy ? 'Checking…' : 'Continue'}
	</Button>
</form>

<style>
	.step {
		display: grid;
		gap: var(--space-4);
	}

	h1 {
		font-size: var(--text-xl);
		font-weight: var(--weight-bold);
		text-align: center;
	}

	.intro {
		color: var(--text-soft);
		font-size: var(--text-base);
		line-height: 1.4;
		text-align: center;
	}

	.field {
		display: grid;
		gap: var(--space-2);
	}

	.label {
		color: var(--text-soft);
		font-size: var(--text-base);
		font-weight: var(--weight-medium);
	}

	.code {
		width: 100%;
		min-height: 56px;
		padding: var(--space-2) var(--space-4);
		border: 1px solid var(--border-strong);
		border-radius: var(--radius-control);
		background: var(--surface);
		color: var(--text);
		font-family: var(--font-mono);
		font-size: var(--text-2xl);
		letter-spacing: var(--tracking-caps);
		text-align: center;
	}

	.code[aria-invalid='true'] {
		border-color: var(--danger);
	}

	.hint {
		color: var(--muted);
		font-size: var(--text-base);
		text-align: center;
	}

	.problem {
		padding: var(--space-3);
		border-radius: var(--radius-control);
		background: var(--danger-bg);
		color: var(--danger);
		font-size: var(--text-base);
	}
</style>

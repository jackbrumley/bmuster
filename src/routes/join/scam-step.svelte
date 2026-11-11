<script lang="ts">
	import {
		SCAM_QUESTIONS,
		scamCheck,
		type ScamAnswer,
		type ScamAnswers,
		type ScamQuestionId
	} from '#lib/domain/machines/phone-support.ts';
	import Button from '#lib/ui/button.svelte';
	import ChipGroup from '#lib/ui/chip-group.svelte';
	import Notice from '#lib/ui/notice.svelte';

	/**
	 * Who gets access and the scam check (SPEC-JOIN J6, J7): the warning, then
	 * three questions with nothing chosen. An unsafe answer stops at once;
	 * Continue appears only when all three are safe.
	 */
	let {
		supportPerson,
		organisation,
		impersonators,
		stop,
		proceed
	}: {
		supportPerson: string;
		organisation: string;
		impersonators: string;
		stop: (question: ScamQuestionId) => void;
		proceed: () => void;
	} = $props();

	let answers = $state<ScamAnswers>({ contacted: null, money: null, virus: null });
	const check = $derived(scamCheck(answers));

	function answer(id: ScamQuestionId, value: ScamAnswer | null): void {
		answers[id] = value;
		const now = scamCheck(answers);
		if (now.kind === 'stop') {
			stop(now.question);
		}
	}
</script>

<div class="step">
	<p class="who">
		After enrolment, people at <strong>{organisation}</strong> with access, such as
		<strong>{supportPerson}</strong> who made this code, can see and control this computer and open its
		files.
	</p>

	<Notice tone="danger" title="Is this a scam?">
		<p class="warning">
			Scammers pretend to be from {impersonators}, and ask you to install remote access. Enrolling
			gives {organisation} control of this computer. If the request was unexpected, stop and check with
			the organisation using contact details you found yourself.
		</p>
		<p class="warning"><strong>If someone called YOU unexpectedly, hang up now.</strong></p>
	</Notice>

	<ol class="questions">
		{#each SCAM_QUESTIONS as question (question.id)}
			<li>
				<p class="question">{question.text}</p>
				<ChipGroup
					label={question.text}
					options={question.options.map((option) => ({ ...option, count: undefined }))}
					bind:value={
						() => answers[question.id],
						(value: ScamAnswer | null) => {
							answer(question.id, value);
						}
					}
				/>
			</li>
		{/each}
	</ol>

	{#if check.kind === 'safe'}
		<Button variant="primary" size="large" type="button" onclick={proceed}>Continue</Button>
	{/if}
</div>

<style>
	.step {
		display: grid;
		gap: var(--space-5);
	}

	.who {
		font-size: var(--text-lg);
		line-height: 1.4;
	}

	.warning {
		font-size: var(--text-base);
		line-height: 1.4;
	}

	.warning + .warning {
		margin-top: var(--space-2);
	}

	.questions {
		display: grid;
		gap: var(--space-5);
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.questions li {
		display: grid;
		gap: var(--space-2);
	}

	.question {
		font-size: var(--text-base);
		font-weight: var(--weight-semibold);
		line-height: 1.4;
	}
</style>

<script lang="ts">
	import {
		errorCopy,
		errorDetail,
		isServerError,
		type ErrorPlace
	} from '#lib/domain/errors/error-copy.ts';
	import ErrorActions from '#lib/ui/error-actions.svelte';
	import ErrorArt from '#lib/ui/error-art.svelte';
	import ErrorFacts from '#lib/ui/error-facts.svelte';
	import PageHeader from '#lib/ui/page-header.svelte';
	import Panel from '#lib/ui/panel.svelte';

	/**
	 * An error inside the console (SPEC-ERROR-PAGES E2): the sidebar and tabs
	 * stay, and the error takes the content area. `header: 'page'` starts it
	 * like any console page; `'machine'` sits under a machine's own header and
	 * tabs, so the title moves into the panel.
	 */
	let {
		status,
		message,
		reference,
		place,
		header
	}: {
		status: number;
		message: string;
		reference: string | undefined;
		place: ErrorPlace;
		header: 'page' | 'machine';
	} = $props();

	const copy = $derived(errorCopy(status, place));
	const serverError = $derived(isServerError(status));
</script>

<svelte:head>
	<title>{copy.title} · BMuster</title>
</svelte:head>

{#if header === 'page'}
	<PageHeader title={copy.title} summary={copy.explanation} actions={undefined} />
{/if}

<Panel heading={undefined} actions={undefined} tone="normal" padding="normal">
	<div class="error">
		<ErrorArt kind={serverError ? 'fault' : 'empty'} />
		<div class="text">
			{#if header === 'machine'}
				<h2>{copy.title}</h2>
				<p class="explanation">{copy.explanation}</p>
			{/if}
			<ErrorFacts {status} detail={errorDetail(status, place, message)} {reference} />
			<div class="actions">
				<ErrorActions home={{ kind: 'machines' }} retry={serverError} size="compact" />
			</div>
		</div>
	</div>
</Panel>

<style>
	.error {
		display: grid;
		justify-items: center;
		gap: var(--space-4);
		text-align: center;
	}

	.text {
		display: grid;
		gap: var(--space-2);
	}

	h2 {
		font-size: var(--text-lg);
		font-weight: var(--weight-semibold);
	}

	.explanation {
		color: var(--text-soft);
	}

	.actions {
		display: flex;
		justify-content: center;
		margin-top: var(--space-2);
	}

	/* Picture beside the words once there is room. */
	@media (min-width: 640px) {
		.error {
			grid-template-columns: auto 1fr;
			justify-items: start;
			align-items: center;
			gap: var(--space-6);
			text-align: start;
		}

		.actions {
			justify-content: flex-start;
		}
	}
</style>

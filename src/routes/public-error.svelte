<script lang="ts">
	import { errorCopy, errorDetail, isServerError } from '#lib/domain/errors/error-copy.ts';
	import PublicPage from '#lib/shell/public-page.svelte';
	import ErrorActions from '#lib/ui/error-actions.svelte';
	import ErrorArt from '#lib/ui/error-art.svelte';
	import ErrorFacts from '#lib/ui/error-facts.svelte';

	/**
	 * An error outside the console (SPEC-ERROR-PAGES E1): an address that
	 * leads nowhere, or a server problem before any console page could load.
	 * In the public frame, like the sign-in page.
	 */
	let {
		status,
		message,
		reference,
		signedIn,
		returnTo
	}: {
		status: number;
		message: string;
		reference: string | undefined;
		signedIn: boolean;
		returnTo: string;
	} = $props();

	const copy = $derived(errorCopy(status, 'page'));
	const serverError = $derived(isServerError(status));
</script>

<svelte:head>
	<title>{copy.title} · BMuster</title>
</svelte:head>

<PublicPage width="compact">
	<div class="error">
		<ErrorArt kind={serverError ? 'fault' : 'empty'} />
		<h1>{copy.title}</h1>
		<p class="explanation">{copy.explanation}</p>
		<ErrorFacts {status} detail={errorDetail(status, 'page', message)} {reference} />
		<div class="actions">
			<ErrorActions
				home={signedIn ? { kind: 'machines' } : { kind: 'sign-in', returnTo }}
				retry={serverError}
				size="large"
			/>
		</div>
	</div>
</PublicPage>

<style>
	.error {
		display: grid;
		justify-items: center;
		gap: var(--space-3);
		text-align: center;
	}

	h1 {
		font-size: var(--text-xl);
		font-weight: var(--weight-bold);
	}

	.explanation {
		color: var(--text-soft);
	}

	/* The buttons fill the card; the text above stays centred. */
	.actions {
		justify-self: stretch;
		margin-top: var(--space-3);
	}
</style>

<script lang="ts">
	import { refreshAll } from '$app/navigation';
	import { otherSessionsEndedReplySchema } from '#lib/schemas/auth/sessions.ts';
	import Button from '#lib/ui/button.svelte';
	import { confirmAction } from '#lib/ui/confirm-action.svelte.ts';
	import Panel from '#lib/ui/panel.svelte';
	import { showToast } from '#lib/ui/toast.svelte.ts';
	import { apiRequest } from '#lib/utils/api-client.ts';

	/**
	 * "Sign out everywhere else" (SPEC-SIGN-IN S21): ends the person's other console sessions,
	 * after asking. `others` is how many are open besides this browser's. AI assistants
	 * connected as the person are not sessions; they stay connected, listed below.
	 */
	let { others }: { others: number } = $props();

	const summary = $derived(
		others === 0
			? 'Only this browser is signed in.'
			: `You are also signed in on ${String(others)} other ${others === 1 ? 'browser or device' : 'browsers or devices'}.`
	);

	async function signOutElsewhere(): Promise<void> {
		const yes = await confirmAction({
			title: 'Sign out everywhere else?',
			message:
				'Every other browser and device signed in as you is signed out at its next click. This browser stays signed in. AI assistants connected as you keep working; disconnect them under Connected AI assistants.',
			confirmLabel: 'Sign out everywhere else'
		});
		if (!yes) {
			return;
		}
		const result = await apiRequest({
			method: 'DELETE',
			url: '/api/account/other-sessions',
			body: undefined,
			reply: otherSessionsEndedReplySchema
		});
		showToast(
			result.ok
				? `Signed out ${result.data.ended === 1 ? '1 other session' : `${String(result.data.ended)} other sessions`}.`
				: result.message,
			result.ok ? 'success' : 'error'
		);
		await refreshAll();
	}
</script>

<Panel heading="Where you are signed in" actions={undefined} tone="normal" padding="normal">
	<p class="text">{summary}</p>
	<div class="actions">
		<Button
			variant="secondary"
			size="compact"
			type="button"
			onclick={others === 0 ? undefined : () => void signOutElsewhere()}
		>
			Sign out everywhere else
		</Button>
	</div>
</Panel>

<style>
	.text {
		color: var(--text-soft);
		font-size: var(--text-sm);
	}

	.actions {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-2);
	}
</style>

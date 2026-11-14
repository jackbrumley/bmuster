<script lang="ts">
	import { refreshAll } from '$app/navigation';
	import { resolve } from '$app/paths';
	import type { AiAccessView } from '#lib/domain/mcp/mcp.ts';
	import { aiAccessReplySchema, unattendedReplySchema } from '#lib/schemas/mcp/console.ts';
	import Button from '#lib/ui/button.svelte';
	import { confirmAction } from '#lib/ui/confirm-action.svelte.ts';
	import Panel from '#lib/ui/panel.svelte';
	import SegmentedControl from '#lib/ui/segmented-control.svelte';
	import { showToast } from '#lib/ui/toast.svelte.ts';
	import { apiRequest } from '#lib/utils/api-client.ts';

	/**
	 * What AI assistants can reach (SPEC-SAVED-COMMANDS SC24, SC25): how many machines the connect
	 * group's rules open to AI, with one-tap rules on All machines; and whether AI may run saved
	 * commands without approval at all (SC21).
	 */
	let { access, unattended }: { access: AiAccessView; unattended: boolean } = $props();

	const ON_OFF: { value: 'on' | 'off'; label: string }[] = [
		{ value: 'on', label: 'On' },
		{ value: 'off', label: 'Off' }
	];

	let busy = $state(false);

	function machinesText(count: number): string {
		return `${String(count)} ${count === 1 ? 'machine' : 'machines'}`;
	}

	async function grant(level: 'view' | 'commands'): Promise<void> {
		const yes = await confirmAction(
			level === 'view'
				? {
						title: 'Let AI view all machines?',
						message:
							'Adds an access rule: the people who may connect an AI assistant get AI can view on All machines. Their assistants can then read every machine, now and later.',
						confirmLabel: 'Let AI view all machines'
					}
				: {
						title: 'Let AI ask to run commands on all machines?',
						message:
							'Adds AI commands on All machines for the people who may connect an AI assistant. Their assistants can then ask to run commands on every machine; each one still waits for approval, except saved commands an admin lets AI run.',
						confirmLabel: 'Let AI ask on all machines'
					}
		);
		if (!yes) {
			return;
		}
		busy = true;
		const result = await apiRequest({
			method: 'POST',
			url: resolve('/api/mcp/ai-access'),
			body: { level },
			reply: aiAccessReplySchema
		});
		busy = false;
		showToast(
			result.ok ? 'The access rule is saved. It is on Access rules.' : result.message,
			result.ok ? 'success' : 'error'
		);
		await refreshAll();
	}

	async function setUnattended(picked: 'on' | 'off' | null): Promise<void> {
		if (picked === null || (picked === 'on') === unattended) {
			return;
		}
		const result = await apiRequest({
			method: 'PUT',
			url: resolve('/api/mcp/unattended'),
			body: { allowed: picked === 'on' },
			reply: unattendedReplySchema
		});
		showToast(
			result.ok
				? picked === 'on'
					? 'Saved commands an admin lets AI run may run without approval.'
					: 'Every saved command an assistant asks for now waits for approval.'
				: result.message,
			result.ok ? 'success' : 'error'
		);
		await refreshAll();
	}
</script>

<Panel heading="What AI can reach" actions={undefined} tone="normal" padding="normal">
	{#if access.kind === 'no-group'}
		<p class="lead">Choose who may connect an AI assistant first.</p>
	{:else}
		<p class="reach">
			AI can see {machinesText(access.canView)}; AI can ask to run commands on {machinesText(
				access.canAsk
			)}.
		</p>
		<p class="lead">
			Counted from the access rules of the people who may connect an assistant. Each rule is on <a
				href={resolve('/(console)/access')}>Access rules</a
			>.
		</p>
		{#if !access.viewsAll || !access.asksAll}
			<div class="buttons">
				{#if !access.viewsAll}
					<Button
						variant="secondary"
						size="compact"
						type="button"
						onclick={busy ? undefined : () => void grant('view')}>Let AI view all machines</Button
					>
				{/if}
				{#if !access.asksAll}
					<Button
						variant="secondary"
						size="compact"
						type="button"
						onclick={busy ? undefined : () => void grant('commands')}
						>…and ask to run commands on all machines</Button
					>
				{/if}
			</div>
		{/if}
	{/if}
</Panel>

<Panel
	heading="Allow AI to run saved commands without approval"
	actions={undefined}
	tone="normal"
	padding="normal"
>
	<p class="lead">
		On: a saved command whose own switch lets AI run it runs at once, when the person may run
		commands on every machine. Off: every saved command an assistant asks for waits for approval.
		Stop all AI access stops them too.
	</p>
	<SegmentedControl
		label="Allow AI to run saved commands without approval"
		options={ON_OFF}
		bind:value={() => (unattended ? 'on' : 'off'), setUnattended}
	/>
</Panel>

<style>
	.reach {
		font-weight: var(--weight-semibold);
		overflow-wrap: anywhere;
	}

	.lead {
		color: var(--muted);
		font-size: var(--text-sm);
	}

	a {
		color: var(--brand);
	}

	.buttons {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-2);
	}
</style>

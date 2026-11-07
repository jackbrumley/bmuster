<script lang="ts">
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { IconTrash } from '@tabler/icons-svelte-runes';
	import Button from '#lib/ui/button.svelte';
	import CopyField from '#lib/ui/copy-field.svelte';
	import { confirmByTyping } from '#lib/ui/confirm-action.svelte.ts';
	import { showToast } from '#lib/ui/toast.svelte.ts';
	import { apiRequest } from '#lib/utils/api-client.ts';
	import { removeMachineReplySchema } from '#lib/schemas/machines/remove-machine.ts';
	import { agentCommands } from '#lib/domain/machines/agent-commands.ts';
	import type { PageProps } from './$types';

	/** The rarely needed things: the agent's commands and removing the machine. */
	let { data }: PageProps = $props();

	const machine = $derived(data.machine);
	const commands = $derived(agentCommands(machine.osFamily));

	async function removeMachine(): Promise<void> {
		const yes = await confirmByTyping({
			title: `Remove ${machine.name}?`,
			message:
				'It disappears from BMuster and its agent is refused from now on. Its history stays in Activity. To use the machine again, uninstall the agent there and add it again with a new join code.',
			confirmLabel: 'Remove machine',
			text: machine.name
		});
		if (!yes) {
			return;
		}
		const result = await apiRequest({
			method: 'DELETE',
			url: `/api/machines/${machine.id}`,
			body: undefined,
			reply: removeMachineReplySchema
		});
		if (!result.ok) {
			showToast(result.message, 'error');
			return;
		}
		showToast(`${machine.name} was removed.`, 'success');
		await goto(resolve('/(console)'));
	}
</script>

<div class="sections">
	<section class="panel">
		<h2>Agent</h2>
		<p class="muted">
			Version {machine.agentVersion}. Run these on the machine itself ({commands.shell.toLowerCase()}).
		</p>
		<div class="command">
			<p class="command-label">Check its status</p>
			<CopyField value={commands.status} label="status command" />
		</div>
		<div class="command">
			<p class="command-label">Uninstall (keeps its identity and logs)</p>
			<CopyField value={commands.uninstall} label="uninstall command" />
		</div>
		<div class="command">
			<p class="command-label">Uninstall and delete everything</p>
			<CopyField value={commands.purge} label="purge command" />
		</div>
		<p class="muted">
			To move this machine to another BMuster server: uninstall with --purge, then run the install
			command from the other server's Add machine page.
		</p>
	</section>

	<section class="panel danger-zone">
		<h2>Danger zone</h2>
		<div class="danger-row">
			<div>
				<p class="danger-title">Remove this machine</p>
				<p class="muted">
					BMuster stops trusting its agent at once. This cannot be undone; adding it again needs a
					new join code.
				</p>
			</div>
			<Button
				variant="danger"
				size="compact"
				type="button"
				onclick={() => {
					void removeMachine();
				}}><IconTrash size={18} /> Remove machine</Button
			>
		</div>
	</section>
</div>

<style>
	.sections {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: var(--space-4);
	}

	.panel {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: var(--space-3);
		padding: var(--space-4);
		border: 1px solid var(--border);
		border-radius: var(--radius-card);
		background: var(--surface-elevated);
		box-shadow: var(--shadow-card);
	}

	h2 {
		font-size: var(--text-sm);
		font-weight: var(--weight-semibold);
		color: var(--muted);
		text-transform: uppercase;
		letter-spacing: var(--tracking-caps);
	}

	.muted {
		color: var(--muted);
		font-size: var(--text-sm);
	}

	.command {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: var(--space-1);
	}

	.command-label {
		color: var(--text-soft);
		font-size: var(--text-xs);
		font-weight: var(--weight-medium);
	}

	.danger-zone {
		border-color: var(--danger);
	}

	.danger-zone h2 {
		color: var(--danger);
	}

	.danger-row {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-4);
	}

	.danger-title {
		font-weight: var(--weight-semibold);
	}
</style>

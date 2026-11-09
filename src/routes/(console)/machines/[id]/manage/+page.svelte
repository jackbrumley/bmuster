<script lang="ts">
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { IconTrash } from '@tabler/icons-svelte-runes';
	import Button from '#lib/ui/button.svelte';
	import CopyField from '#lib/ui/copy-field.svelte';
	import Panel from '#lib/ui/panel.svelte';
	import { confirmByTyping } from '#lib/ui/confirm-action.svelte.ts';
	import { showToast } from '#lib/ui/toast.svelte.ts';
	import { apiRequest } from '#lib/utils/api-client.ts';
	import { removeMachineReplySchema } from '#lib/schemas/machines/remove-machine.ts';
	import { agentCommands } from '#lib/domain/machines/agent-commands.ts';
	import AgentUpdate from './agent-update.svelte';
	import LocalPage from './local-page.svelte';
	import MachineDetails from './machine-details.svelte';
	import MachineGroups from './machine-groups.svelte';
	import MachineChecks from './machine-checks.svelte';
	import MachineLogs from './machine-logs.svelte';
	import MachineSessions from './machine-sessions.svelte';
	import PowerPolicy from './power-policy.svelte';
	import ReinstallAgent from './reinstall-agent.svelte';
	import type { PageProps } from './$types';

	/**
	 * The rarely needed things: the name and description, the agent's commands,
	 * reinstalling the agent, and removing the machine.
	 */
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

<MachineDetails {machine} />

<MachineGroups machineId={machine.id} groups={data.machineGroups} />

<Panel heading="Agent" actions={undefined} tone="normal" padding="normal">
	<AgentUpdate machineId={machine.id} version={machine.agentVersion} update={machine.update} />
	<p class="muted">Run these on the machine itself ({commands.shell.toLowerCase()}).</p>
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
	<div class="command">
		<p class="command-label">
			Move to another BMuster server (make a join code on its Add machine page first)
		</p>
		<CopyField value={commands.rejoin} label="rejoin command" />
	</div>
	<p class="muted">
		The agent joins the other server first and only then leaves this one, which then shows it as
		moved. The local page below can do the same.
	</p>
</Panel>

<PowerPolicy
	machineId={machine.id}
	machineName={machine.name}
	keepAwakeOnAc={data.keepAwakeOnAc}
	power={machine.inventory.kind === 'known' ? machine.inventory.power : { kind: 'pending' }}
/>

<LocalPage machineId={machine.id} localPage={data.localPage} />

<ReinstallAgent
	{machine}
	origin={page.url.origin}
	downloads={data.downloads}
	localTls={data.localTls}
/>

<MachineLogs
	machineId={machine.id}
	machineName={machine.name}
	sendsLogs={machine.inventory.kind === 'pending' ||
		machine.inventory.display.kind !== 'unreported'}
	verboseUntilIso={data.verboseUntilIso}
/>

<MachineChecks machineId={machine.id} machineName={machine.name} />

<MachineSessions machineId={machine.id} />

<Panel heading="Danger zone" actions={undefined} tone="danger" padding="normal">
	<div class="danger-row">
		<div>
			<p class="danger-title">Remove this machine</p>
			<p class="muted">
				BMuster stops trusting its agent at once. This cannot be undone; adding it again needs a new
				join code.
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
</Panel>

<style>
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

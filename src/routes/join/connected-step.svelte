<script lang="ts">
	import { IconCircleCheck } from '@tabler/icons-svelte-runes';
	import { agentCommands } from '#lib/domain/machines/agent-commands.ts';
	import { LOCAL_PAGE_ADDRESS } from '#lib/domain/machines/phone-support.ts';
	import CopyField from '#lib/ui/copy-field.svelte';

	/** The computer has enrolled (SPEC-JOIN J10), and how to remove the agent later. */
	let { organisation, supportPerson }: { organisation: string; supportPerson: string } = $props();

	const windows = agentCommands('windows');
	const linux = agentCommands('linux');
</script>

<div class="step">
	<div class="title">
		<IconCircleCheck size={48} stroke={1.75} />
		<h1>Enrolled. This computer is now managed by {organisation}.</h1>
	</div>
	<p class="who">
		People at {organisation} with access, such as {supportPerson}, can now see and control it.
	</p>

	<section class="remove" aria-labelledby="remove-heading">
		<h2 id="remove-heading">To remove it later</h2>
		<div class="remove-body">
			<p>On Windows, in <strong>Windows PowerShell (Admin)</strong>:</p>
			<CopyField value={windows.purge} label="Windows uninstall command" />
			<p>On Linux, in <strong>Terminal</strong>:</p>
			<CopyField value={linux.purge} label="Linux uninstall command" />
			<p>
				Or open <strong>{LOCAL_PAGE_ADDRESS}</strong> on this computer: the BMuster Agent’s own page can
				remove it too.
			</p>
		</div>
	</section>
</div>

<style>
	.step {
		display: grid;
		gap: var(--space-5);
	}

	.title {
		display: grid;
		justify-items: center;
		gap: var(--space-2);
		color: var(--success);
		text-align: center;
	}

	h1 {
		font-size: var(--text-xl);
		font-weight: var(--weight-bold);
		color: var(--text);
	}

	.who {
		font-size: var(--text-base);
		line-height: 1.4;
		text-align: center;
	}

	h2 {
		font-size: var(--text-base);
		font-weight: var(--weight-semibold);
	}

	.remove-body {
		display: grid;
		gap: var(--space-2);
		padding-top: var(--space-2);
		font-size: var(--text-sm);
	}
</style>

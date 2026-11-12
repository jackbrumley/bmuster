<script lang="ts">
	import type { Snippet } from 'svelte';
	import ConsoleLayout from './+layout.svelte';
	import MachineLayout from './machines/[id]/+layout.svelte';
	import type { LayoutData as ConsoleData } from './$types';
	import type { LayoutData as MachineData } from './machines/[id]/$types';

	/**
	 * A console page as the browser gets it: inside the console layout (ShellFrame), and for a
	 * machine tab also inside the machine layout (its header, tabs and live status). Only for tests
	 * that look at a whole page, such as its width on a phone (phone-overflow.svelte.test.ts).
	 */
	let {
		frame,
		children
	}: {
		frame: { kind: 'console'; data: ConsoleData } | { kind: 'machine'; data: MachineData };
		children: Snippet;
	} = $props();
</script>

{#if frame.kind === 'machine'}
	<ConsoleLayout data={frame.data} params={{}}>
		<MachineLayout data={frame.data} params={{ id: frame.data.machine.id }}>
			{@render children()}
		</MachineLayout>
	</ConsoleLayout>
{:else}
	<ConsoleLayout data={frame.data} params={{}}>
		{@render children()}
	</ConsoleLayout>
{/if}

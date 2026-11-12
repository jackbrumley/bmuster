<script lang="ts">
	import MachineLayout from '../../src/routes/(console)/machines/[id]/+layout.svelte';
	import Overview from '../../src/routes/(console)/machines/[id]/+page.svelte';
	import type { PageData } from '../../src/routes/(console)/machines/[id]/$types';

	/** A machine's Overview inside its layout (header, tabs, live status), as the console shows it. */
	let { data }: { data: PageData } = $props();
</script>

<MachineLayout params={{ id: data.machine.id }} {data}>
	<Overview params={{ id: data.machine.id }} {data} />
</MachineLayout>

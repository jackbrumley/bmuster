<script lang="ts">
	import { untrack, type Snippet } from 'svelte';
	import {
		provideMachinePresence,
		type MachinePresence
	} from '#lib/runes/machine-presence.svelte.ts';

	/**
	 * What the machine layout gives its tabs in a test that renders a tab on
	 * its own: the machine's one live status (SPEC-PRESENCE P10). The presence
	 * is fixed for the life of the render.
	 */
	let { presence, children }: { presence: MachinePresence; children: Snippet } = $props();

	provideMachinePresence(untrack(() => presence));
</script>

{@render children()}

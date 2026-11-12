<script lang="ts">
	import type { Snippet } from 'svelte';
	import { machinePresence } from '#lib/runes/machine-presence.svelte.ts';

	/**
	 * For a tab that starts or attaches to its session when it mounts
	 * (Terminal, Desktop): it mounts again whenever the machine comes online
	 * or stops being online, so it opens by itself when the machine is back
	 * (SPEC-PRESENCE P10).
	 */
	let { children }: { children: Snippet } = $props();

	const presence = machinePresence();
	const online = $derived(presence.status.kind === 'online');
</script>

{#key online}
	{@render children()}
{/key}

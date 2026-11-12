<script lang="ts">
	import RemountOnPresence from '../remount-on-presence.svelte';
	import type { LayoutProps } from './$types';

	/** The terminal mounts again when the machine comes online or goes (SPEC-PRESENCE P10). */
	let { children }: LayoutProps = $props();
</script>

<RemountOnPresence {children} />

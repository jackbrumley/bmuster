<script lang="ts">
	import ShellFrame from '#lib/shell/shell-frame.svelte';
	import type { LayoutProps } from './$types';

	let { children }: LayoutProps = $props();
</script>

<ShellFrame>
	{@render children()}
</ShellFrame>

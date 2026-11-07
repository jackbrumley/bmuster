<script lang="ts">
	import ShellFrame from '#lib/shell/shell-frame.svelte';
	import type { LayoutProps } from './$types';

	let { data, children }: LayoutProps = $props();
</script>

<ShellFrame user={data.user}>
	{@render children()}
</ShellFrame>

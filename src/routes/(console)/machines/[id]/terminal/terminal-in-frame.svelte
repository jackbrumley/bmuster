<script lang="ts">
	import '../../../../../app.css';
	import ShellFrame from '#lib/shell/shell-frame.svelte';
	import TerminalTab from './+page.svelte';
	import type { PageProps } from './$types';

	/**
	 * The terminal tab inside the console frame, with the real tokens: what
	 * the layout tests measure (the page gutter, the screen's width).
	 */
	let { pageProps }: { pageProps: PageProps } = $props();
</script>

<ShellFrame user={pageProps.data.user} localNetworkMode={false} runCommands={false}>
	<TerminalTab {...pageProps} />
</ShellFrame>

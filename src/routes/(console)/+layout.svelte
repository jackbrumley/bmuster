<script lang="ts">
	import ServerUpdateNotice from '#lib/shell/server-update-notice.svelte';
	import ShellFrame from '#lib/shell/shell-frame.svelte';
	import type { LayoutProps } from './$types';

	let { data, children }: LayoutProps = $props();
</script>

<ShellFrame
	user={data.user}
	localNetworkMode={data.localNetworkMode}
	runCommands={data.runCommands}
	assistant={data.assistant}
>
	<ServerUpdateNotice initial={data.serverUpdate} />
	{@render children()}
</ShellFrame>

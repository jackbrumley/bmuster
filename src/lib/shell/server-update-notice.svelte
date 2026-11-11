<script lang="ts">
	import { onMount } from 'svelte';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { showsUpdateNotice } from '#lib/domain/releases/server-update-notice.ts';
	import type { ServerUpdateView } from '#lib/schemas/releases/server-updates.ts';
	import { serverUpdateViewSchema } from '#lib/schemas/releases/server-updates.ts';
	import Notice from '#lib/ui/notice.svelte';
	import { apiRequest } from '#lib/utils/api-client.ts';
	let { initial }: { initial: ServerUpdateView | null } = $props();
	let view = $state<ServerUpdateView | null>(null);
	onMount(() => {
		view = initial;
		const refresh = async (): Promise<void> => {
			if (document.visibilityState !== 'visible' || view === null) return;
			const result = await apiRequest({
				method: 'GET',
				url: '/api/server-updates',
				body: undefined,
				reply: serverUpdateViewSchema
			});
			if (result.ok) view = result.data;
		};
		const timer = setInterval(() => void refresh(), 30_000);
		return () => {
			clearInterval(timer);
		};
	});
</script>

{#if showsUpdateNotice(view, page.route.id === '/(console)/updates' ? 'updates' : 'other')}
	<Notice tone="info" title="BMuster {view.release.version} is available">
		<p><a href={resolve('/(console)/updates')}>Review the release and update options</a></p>
	</Notice>
{/if}

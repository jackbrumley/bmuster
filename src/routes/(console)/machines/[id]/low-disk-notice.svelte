<script lang="ts">
	import { resolve } from '$app/paths';
	import type { LowDisk } from '#lib/domain/storage/storage.ts';
	import Notice from '#lib/ui/notice.svelte';
	import { formatBytes } from '#lib/utils/format.ts';

	/**
	 * "Disk nearly full" on the machine's Overview and Storage tab (SPEC-STORAGE 12): each drive at
	 * 90 % used or more. `storageOf` links to the Storage tab (people with `files`, not on the tab
	 * itself); `undefined` shows no link.
	 */
	let { drives, storageOf }: { drives: readonly LowDisk[]; storageOf: string | undefined } =
		$props();
</script>

{#if drives.length > 0}
	<Notice tone="warning" title="Disk nearly full">
		<ul>
			{#each drives as drive (drive.mount)}
				<li>{drive.mount} is {drive.percent} % full, {formatBytes(drive.freeBytes)} free.</li>
			{/each}
		</ul>
		{#if storageOf !== undefined}
			<p>
				<a href={resolve('/(console)/machines/[id]/storage', { id: storageOf })}
					>Open Storage to see what is using it and clean up</a
				>
			</p>
		{/if}
	</Notice>
{/if}

<style>
	ul {
		margin: 0;
		padding-left: var(--space-4);
	}

	p {
		margin: var(--space-1) 0 0;
	}

	a {
		color: var(--brand);
	}
</style>

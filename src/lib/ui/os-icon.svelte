<script lang="ts">
	import { IconBrandApple, IconBrandUbuntu, IconBrandWindows } from '@tabler/icons-svelte-runes';
	import type { OsFamily } from '#lib/domain/machines/machine.ts';

	let { family, size }: { family: OsFamily; size: number } = $props();
</script>

<span class="os-icon" title={family}>
	{#if family === 'windows'}
		<IconBrandWindows {size} stroke={1.75} />
	{:else if family === 'linux'}
		<IconBrandUbuntu {size} stroke={1.75} />
	{:else}
		<IconBrandApple {size} stroke={1.75} />
	{/if}
</span>

<style>
	.os-icon {
		display: inline-flex;
		color: var(--text-soft);
	}
</style>

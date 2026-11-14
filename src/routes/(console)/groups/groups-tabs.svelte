<script lang="ts">
	import { page } from '$app/state';
	import { resolve } from '$app/paths';
	import { IconDevices, IconUsers } from '@tabler/icons-svelte-runes';
	import TabNav from '#lib/ui/tab-nav.svelte';

	/**
	 * The Groups pages' tabs (SPEC-ACCESS A1–A3): groups of people and groups of
	 * machines each on their own tab, so a long list of one never pushes the other off screen.
	 */
	const tabs = [
		{ href: resolve('/(console)/groups'), label: 'People', icon: IconUsers },
		{ href: resolve('/(console)/groups/machines'), label: 'Machines', icon: IconDevices }
	];
</script>

<TabNav label="Groups" {tabs} current={page.url.pathname} />

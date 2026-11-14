<script lang="ts">
	import { page } from '$app/state';
	import { resolve } from '$app/paths';
	import { IconBookmark, IconHistory } from '@tabler/icons-svelte-runes';
	import TabNav from '#lib/ui/tab-nav.svelte';

	/** The Commands pages: past runs (SPEC-COMMANDS C20) and saved commands (SPEC-SAVED-COMMANDS SC1). */
	const tabs = [
		{ href: resolve('/(console)/commands'), label: 'Runs', icon: IconHistory },
		{ href: resolve('/(console)/commands/saved'), label: 'Saved commands', icon: IconBookmark }
	];
</script>

<TabNav label="Commands" {tabs} current={page.url.pathname} />

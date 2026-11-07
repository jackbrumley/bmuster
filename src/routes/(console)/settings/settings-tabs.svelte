<script lang="ts">
	import { page } from '$app/state';
	import { resolve } from '$app/paths';
	import { IconAdjustments, IconBell, IconMail } from '@tabler/icons-svelte-runes';
	import TabNav from '#lib/ui/tab-nav.svelte';

	/** The Settings pages: General, Email and Notifications (SPEC-EMAIL E1, E6). */
	const tabs = [
		{ href: resolve('/(console)/settings'), label: 'General', icon: IconAdjustments },
		{ href: resolve('/(console)/settings/email'), label: 'Email', icon: IconMail },
		{ href: resolve('/(console)/settings/notifications'), label: 'Notifications', icon: IconBell }
	];
</script>

<TabNav label="Settings" {tabs} current={page.url.pathname} />

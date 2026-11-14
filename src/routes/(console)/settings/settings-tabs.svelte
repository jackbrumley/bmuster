<script lang="ts">
	import { page } from '$app/state';
	import { resolve } from '$app/paths';
	import {
		IconAdjustments,
		IconBell,
		IconKey,
		IconMail,
		IconPlugConnected
	} from '@tabler/icons-svelte-runes';
	import TabNav from '#lib/ui/tab-nav.svelte';

	/**
	 * The Settings pages: General, Email and Notifications (SPEC-EMAIL E1, E6), and Diagnostics
	 * tokens (SPEC-AGENT-LOGS 4), and AI assistants (SPEC-MCP).
	 */
	const tabs = [
		{ href: resolve('/(console)/settings'), label: 'General', icon: IconAdjustments },
		{ href: resolve('/(console)/settings/email'), label: 'Email', icon: IconMail },
		{ href: resolve('/(console)/settings/notifications'), label: 'Notifications', icon: IconBell },
		{ href: resolve('/(console)/settings/diagnostics'), label: 'Diagnostics', icon: IconKey },
		{
			href: resolve('/(console)/settings/ai-assistants'),
			label: 'AI assistants',
			icon: IconPlugConnected
		}
	];
</script>

<TabNav label="Settings" {tabs} current={page.url.pathname} />

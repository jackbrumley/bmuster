<script lang="ts">
	import { page } from '$app/state';
	import { IconLinkOff } from '@tabler/icons-svelte-runes';
	import PublicPage from '#lib/shell/public-page.svelte';
	import EmptyState from '#lib/ui/empty-state.svelte';

	/**
	 * A share link that does not work (SPEC-SHARE-LINKS SL5): wrong, expired
	 * and ended links all get this same plain page, saying nothing about why,
	 * which machine or whose. A paused address is told to wait.
	 */
	const paused = $derived(page.status === 429);
</script>

<svelte:head>
	<title>{paused ? 'Too many tries' : 'This link has ended'} · BMuster</title>
	<meta name="referrer" content="no-referrer" />
</svelte:head>

<PublicPage width="compact">
	<EmptyState
		icon={IconLinkOff}
		title={paused ? 'Too many tries' : 'This link has ended'}
		detail={paused
			? 'Too many tries from this address. Try again in 15 minutes.'
			: 'Ask the person who sent it for a new one if you still need access.'}
		children={undefined}
	/>
</PublicPage>

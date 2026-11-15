<script lang="ts">
	import '../app.css';
	import { beforeNavigate } from '$app/navigation';
	import { asset } from '$app/paths';
	import { updated } from '$app/state';
	import { fullLoadTarget } from '#lib/utils/app-version.ts';
	import type { LayoutProps } from './$types';

	let { children }: LayoutProps = $props();

	// Once the server runs a newer build, the next navigation loads the whole
	// page, so it never asks for the old build's code (SPEC-SERVER-UPDATES SU18).
	beforeNavigate((navigation) => {
		const target = fullLoadTarget(navigation, updated.current);
		if (target !== undefined) {
			window.location.href = target.href;
		}
	});
</script>

<svelte:head>
	<link rel="icon" href={asset('favicon.svg')} type="image/svg+xml" />
	<link rel="apple-touch-icon" href={asset('apple-touch-icon.png')} />
	<link rel="manifest" href={asset('manifest.webmanifest')} />
	<title>BMuster</title>
</svelte:head>

{@render children()}

<script lang="ts">
	import { hasPermission } from '#lib/domain/access/access.ts';
	import type { DesktopMode } from '#lib/domain/sessions/session.ts';
	import { signedInUserOf } from '#lib/domain/machines/machine.ts';
	import WindowFrame from '#lib/shell/window-frame.svelte';
	import { consoleSessionRoute } from '#lib/runes/session-link.svelte.ts';
	import DesktopStart from '../desktop-start.svelte';
	import DesktopView from '../desktop-view.svelte';
	import type { PageProps } from './$types';

	/**
	 * The machine's screen in a window of its own (SPEC-DESKTOP-POPOUT 9–12):
	 * the tab's Pop out opens it with the running session in its address,
	 * and it joins that session the way a reload does, so the session moves
	 * here rather than doubling. The picture fills the window with the same
	 * controls as full screen (SPEC-DESKTOP 23): the floating bar with a
	 * mouse, the controls button on touch. No console around it.
	 */
	let { data }: PageProps = $props();

	const machine = $derived(data.machine);
	const canControl = $derived(hasPermission(data.grants, 'desktop-control'));

	/** The rules for this mode ask the person at the screen first (BMuster cannot ask yet). */
	const asksFirst = $derived(
		data.grants.some(
			(grant) =>
				grant.permission === (canControl ? 'desktop-control' : 'desktop-view') &&
				grant.consent === 'ask'
		)
	);
</script>

<svelte:head>
	<title>{machine.name}</title>
</svelte:head>

<WindowFrame>
	<DesktopView
		{machine}
		route={consoleSessionRoute('desktop', machine.id)}
		{canControl}
		files={{ kind: 'machine', canFiles: hasPermission(data.grants, 'files') }}
		frame={{ kind: 'window' }}
	>
		{#snippet start(begin: (mode: DesktopMode) => void)}
			<DesktopStart user={signedInUserOf(machine)} {canControl} {asksFirst} onstart={begin} />
		{/snippet}
	</DesktopView>
</WindowFrame>

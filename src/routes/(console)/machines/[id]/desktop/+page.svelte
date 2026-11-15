<script lang="ts">
	import { resolve } from '$app/paths';
	import { hasPermission, type Permission } from '#lib/domain/access/access.ts';
	import type { DesktopMode } from '#lib/domain/sessions/session.ts';
	import { signedInUserOf } from '#lib/domain/machines/machine.ts';
	import { machinePresence } from '#lib/runes/machine-presence.svelte.ts';
	import { consoleSessionRoute } from '#lib/runes/session-link.svelte.ts';
	import MachineUnreachable from '../machine-unreachable.svelte';
	import NoPermission from '../no-permission.svelte';
	import DesktopStart from './desktop-start.svelte';
	import DesktopView from './desktop-view.svelte';
	import type { PageProps } from './$types';

	/**
	 * The machine's screen on its Desktop tab (SPEC-DESKTOP): JPEG tiles drawn
	 * on a canvas, the cursor drawn locally, mouse, keyboard and touch sent
	 * back, with the same controls as every desktop view (`desktop-view.svelte`,
	 * SPEC-DESKTOP 23). The session runs on the server and the agent: a reload
	 * comes back to it. The person at the machine sees a notice bar while
	 * anyone is connected.
	 */
	let { data }: PageProps = $props();

	const machine = $derived(data.machine);
	// The machine page's one live status (SPEC-PRESENCE P10); ./+layout.svelte remounts the tab when it changes.
	const presence = machinePresence();
	const presenceStatus = $derived(presence.status);
	const canWatch = $derived(hasPermission(data.grants, 'desktop-view'));
	const canControl = $derived(hasPermission(data.grants, 'desktop-control'));

	/** True when the person's rules for this mode ask the person at the screen first. */
	function asksFirst(mode: DesktopMode): boolean {
		const needed: Permission = mode === 'control' ? 'desktop-control' : 'desktop-view';
		return data.grants.some((grant) => grant.permission === needed && grant.consent === 'ask');
	}
</script>

{#if !canWatch}
	<NoPermission />
{:else if presenceStatus.kind !== 'online'}
	<MachineUnreachable status={presenceStatus} detail="The desktop opens when it is back." />
{:else}
	<div class="session">
		<DesktopView
			{machine}
			route={consoleSessionRoute('desktop', machine.id)}
			{canControl}
			files={{ kind: 'machine', canFiles: hasPermission(data.grants, 'files') }}
			frame={{
				kind: 'page',
				popOutPage: resolve('/(console)/machines/[id]/desktop/window', { id: machine.id })
			}}
		>
			{#snippet start(begin: (mode: DesktopMode) => void)}
				<DesktopStart
					user={signedInUserOf(machine)}
					{canControl}
					asksFirst={asksFirst(canControl ? 'control' : 'watch')}
					onstart={begin}
				/>
			{/snippet}
		</DesktopView>
	</div>
{/if}

<style>
	.session {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: var(--space-3);
	}
</style>

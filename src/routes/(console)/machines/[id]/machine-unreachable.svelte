<script lang="ts">
	import { IconPlugConnected, IconRefresh } from '@tabler/icons-svelte-runes';
	import type { MachineStatus } from '#lib/domain/machines/machine.ts';
	import EmptyState from '#lib/ui/empty-state.svelte';

	/**
	 * A machine tab that needs the machine, while it is not online
	 * (SPEC-PRESENCE P10): it says Reconnecting or Offline, as the header's
	 * badge does, and the tab opens by itself when the machine is back.
	 */
	let { status, detail }: { status: Exclude<MachineStatus, { kind: 'online' }>; detail: string } =
		$props();
</script>

<EmptyState
	icon={status.kind === 'reconnecting' ? IconRefresh : IconPlugConnected}
	title={status.kind === 'reconnecting'
		? 'This machine is reconnecting.'
		: 'This machine is offline.'}
	{detail}
	children={undefined}
/>

<script lang="ts">
	import { resolve } from '$app/paths';
	import type { UpdateGroup } from '#lib/domain/machines/agent-updates.ts';
	import Notice from '#lib/ui/notice.svelte';
	import Panel from '#lib/ui/panel.svelte';
	import { formatRelative } from '#lib/utils/format.ts';

	type TestChannel = {
		group: UpdateGroup;
		build:
			| { kind: 'none' }
			| { kind: 'build'; version: string; machines: { id: string; name: string }[] };
		check: { checkedAtIso: string | null; problem: string | null };
	};

	/**
	 * The Test channel (SPEC-TEST-CHANNEL): the newest test build on offer, the machines that run
	 * it, the built-in Test group, and the last time the server looked on GitHub.
	 */
	let { channel, now }: { channel: TestChannel; now: number } = $props();

	const count = $derived(
		`${String(channel.group.machines)} ${channel.group.machines === 1 ? 'machine' : 'machines'}`
	);

	/** Opens the Test group on the Groups page. */
	const groupHref = $derived(
		resolve(
			`/(console)/groups?${new URLSearchParams({ machineGroup: channel.group.id }).toString()}`
		)
	);
</script>

<Panel heading="Test channel" actions={undefined} tone="normal" padding="normal">
	{#if channel.build.kind === 'build'}
		<dl class="facts">
			<div>
				<dt>On offer</dt>
				<dd>Test build {channel.build.version}</dd>
			</div>
			<div>
				<dt>Running it</dt>
				<dd>
					{channel.build.machines.length === 0
						? 'No machine yet'
						: channel.build.machines.map((machine) => machine.name).join(', ')}
				</dd>
			</div>
		</dl>
	{:else}
		<p class="muted">
			No test build on offer. Test builds are GitHub pre-releases (tags like
			<code>v0.4.14-test.1</code>); while {channel.group.name} has machines, this server looks for the
			newest every hour and on Check for updates.
		</p>
	{/if}
	{#if channel.check.problem !== null}
		<Notice tone="danger" title="The last look for test builds failed">
			<p>
				{channel.check.problem}{channel.check.checkedAtIso === null
					? ''
					: ` (${formatRelative(channel.check.checkedAtIso, now)})`}
			</p>
		</Notice>
	{:else if channel.check.checkedAtIso !== null}
		<p class="muted">Looked on GitHub {formatRelative(channel.check.checkedAtIso, now)}.</p>
	{/if}
	<p class="group">
		Machines in {channel.group.name} get test builds as soon as they are published; every other machine
		stays on full releases. {count} —
		<a href={groupHref}>open the {channel.group.name} group</a>
	</p>
</Panel>

<style>
	.facts {
		display: grid;
		gap: var(--space-3);
		margin: 0;
	}

	dt {
		color: var(--text-soft);
		font-size: var(--text-xs);
		font-weight: var(--weight-medium);
	}

	dd {
		margin: 0;
		overflow-wrap: anywhere;
	}

	.muted {
		color: var(--muted);
		font-size: var(--text-sm);
	}

	.group {
		color: var(--text-soft);
		font-size: var(--text-sm);
	}

	.group a {
		color: var(--brand);
	}

	code {
		font-family: var(--font-mono);
		font-size: var(--text-sm);
	}
</style>

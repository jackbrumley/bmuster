<script lang="ts">
	/**
	 * The small print under an error's title (SPEC-ERROR-PAGES E1, E5): the
	 * message the route wrote, if it adds anything, then the status code and
	 * the reference of the server log line, for quoting to whoever runs the
	 * server.
	 */
	let {
		status,
		detail,
		reference
	}: {
		status: number;
		detail: { kind: 'none' } | { kind: 'message'; text: string };
		reference: string | undefined;
	} = $props();
</script>

{#if detail.kind === 'message'}
	<p class="detail">{detail.text}</p>
{/if}
<p class="codes">
	Error {status}{#if reference !== undefined}
		&ensp;·&ensp;Error reference: <code>{reference}</code>{/if}
</p>

<style>
	.detail {
		color: var(--text-soft);
		font-size: var(--text-sm);
		overflow-wrap: anywhere;
	}

	.codes {
		color: var(--muted);
		font-size: var(--text-xs);
	}

	code {
		font-family: var(--font-mono);
		color: var(--text-soft);
		user-select: all;
	}
</style>

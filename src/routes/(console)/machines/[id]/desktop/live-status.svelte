<script lang="ts">
	import type { SessionStatus } from './session-actions.ts';

	/**
	 * The session's status on the bars and in the sheet. The frame rate and
	 * speed sit in boxes of a fixed width, in figures of one width, so the
	 * bar around them keeps its size as they change (SPEC-DESKTOP-FLOATING FB1).
	 */
	let { status }: { status: SessionStatus } = $props();
</script>

<span class="status" role="status"
	>{#if status.kind === 'figures'}<span class="figure fps">{status.fps}</span> fps ·
		<span class="figure speed">{status.kilobytes}</span> KB/s{:else}{status.text}{/if}</span
>

<style>
	.status {
		color: var(--muted);
		font-size: var(--text-xs);
		font-variant-numeric: tabular-nums;
		white-space: nowrap;
	}

	.figure {
		display: inline-block;
		text-align: end;
	}

	/* Up to 999 frames a second and 99999 KB/s (about 100 MB/s) without moving. */
	.fps {
		width: 3ch;
	}

	.speed {
		width: 5ch;
	}
</style>

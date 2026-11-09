<script lang="ts">
	/**
	 * The one loading mark of the console (SPEC-LOADING): a small radar whose
	 * soft sweep turns once every 2.4 s over two faint rings, with a blip that
	 * glows as the sweep passes it. `small` (24px) sits inline in buttons and
	 * rows, `medium` (48px) in a block, `large` (96px) in LoadingVeil.
	 *
	 * It is decoration: the words beside it (the button label, the veil's
	 * title) say what is happening. With reduced motion the sweep stops and
	 * the radar breathes gently instead.
	 */
	let { size }: { size: 'small' | 'medium' | 'large' } = $props();
</script>

<span class="radar {size}" data-radar={size} aria-hidden="true">
	<span class="ring outer"></span>
	<span class="ring inner"></span>
	<span class="sweep"></span>
	<span class="blip"></span>
	<span class="core"></span>
</span>

<style>
	.radar {
		position: relative;
		display: inline-block;
		flex: none;
		vertical-align: middle;
		border-radius: var(--radius-round);
		background: radial-gradient(
			circle,
			color-mix(in oklab, var(--brand) 10%, transparent) 0%,
			transparent 70%
		);
	}

	.small {
		width: 24px;
		height: 24px;
	}

	.medium {
		width: 48px;
		height: 48px;
	}

	.large {
		width: 96px;
		height: 96px;
	}

	.ring,
	.sweep,
	.blip,
	.core {
		position: absolute;
		border-radius: var(--radius-round);
	}

	.ring {
		border: 1px solid color-mix(in oklab, var(--muted) 40%, transparent);
	}

	.outer {
		inset: 0;
	}

	.inner {
		inset: 25%;
		border-color: color-mix(in oklab, var(--muted) 28%, transparent);
	}

	/*
	 * The sweep is a cone that is clear for most of its turn and brightens
	 * towards its leading edge (at 0deg, the top, as it turns clockwise), so
	 * it trails off like a phosphor afterglow.
	 */
	.sweep {
		inset: 0;
		background: conic-gradient(
			from 0deg,
			transparent 0deg,
			transparent 200deg,
			color-mix(in oklab, var(--brand) 12%, transparent) 280deg,
			color-mix(in oklab, var(--brand) 55%, transparent) 356deg,
			var(--brand) 360deg
		);
		animation: radar-sweep 2.4s linear infinite;
	}

	/* The blip sits 60deg clockwise of the top, where the sweep passes it a sixth into the turn. */
	.blip {
		top: 33%;
		left: 70%;
		width: 16%;
		height: 16%;
		background: radial-gradient(
			circle,
			var(--brand) 0%,
			var(--brand) 32%,
			color-mix(in oklab, var(--brand) 30%, transparent) 50%,
			transparent 72%
		);
		opacity: 0;
		transform: translate(-50%, -50%);
		animation: radar-blip 2.4s linear infinite;
	}

	.core {
		top: 50%;
		left: 50%;
		width: 8%;
		height: 8%;
		min-width: 2px;
		min-height: 2px;
		background: var(--brand);
		transform: translate(-50%, -50%);
	}

	.small .inner {
		inset: 30%;
	}

	@keyframes radar-sweep {
		to {
			transform: rotate(1turn);
		}
	}

	@keyframes radar-blip {
		0%,
		15% {
			opacity: 0;
			transform: translate(-50%, -50%) scale(0.6);
		}

		19% {
			opacity: 1;
			transform: translate(-50%, -50%) scale(1.15);
		}

		70%,
		100% {
			opacity: 0;
			transform: translate(-50%, -50%) scale(0.9);
		}
	}

	@keyframes radar-breathe {
		0%,
		100% {
			opacity: 0.55;
		}

		50% {
			opacity: 1;
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.radar {
			animation: radar-breathe 2.4s ease-in-out infinite;
		}

		.sweep,
		.blip {
			animation: none;
		}

		.blip {
			opacity: 0.8;
		}
	}
</style>

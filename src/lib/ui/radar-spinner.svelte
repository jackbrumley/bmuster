<script lang="ts">
	/**
	 * The one loading mark of BMuster (SPEC-LOADING): the icon come alive
	 * (SPEC-BRAND-ICON). A night radar whose beam turns once every 2.4 s, its
	 * trail almost as bright as the beam where they touch and fading over
	 * almost half a turn, and whose four contacts flare as the beam passes,
	 * then fade. Sizes: `tiny` (16px, inside a badge), `small` (24px, inline in buttons and rows), `medium`
	 * (48px, in a block), `large` (96px, in LoadingVeil).
	 *
	 * It is decoration: the words beside it (the button label, the veil's
	 * title) say what is happening. With reduced motion the sweep stops and
	 * the radar breathes gently instead.
	 */
	let { size }: { size: 'tiny' | 'small' | 'medium' | 'large' } = $props();
</script>

<span class="radar {size}" data-radar={size} aria-hidden="true">
	<span class="sweep"></span>
	<span class="ring outer"></span>
	<span class="ring inner"></span>
	<!-- The icon's contacts, clockwise from the top: 65, 12, 315 and 210 degrees. -->
	<span class="contact newest"></span>
	<span class="contact second"></span>
	<span class="contact faint"></span>
	<span class="contact old"></span>
	<span class="core"></span>
</span>

<style>
	/* The icon's dark face, rim, rings, lime beam and pale contacts. */
	.radar {
		position: relative;
		display: inline-block;
		flex: none;
		overflow: hidden;
		vertical-align: middle;
		border-radius: var(--radius-round);
		background: var(--radar-face);
		box-sizing: border-box;
		border: 1px solid var(--radar-rim);
	}

	.tiny {
		width: 16px;
		height: 16px;
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
	.contact,
	.core {
		position: absolute;
		border-radius: var(--radius-round);
	}

	.ring {
		border: 1px solid var(--radar-ring);
	}

	.outer {
		inset: 4%;
	}

	.inner {
		inset: 29%;
		border-color: var(--radar-ring-faint);
	}

	/*
	 * The trail: clear for the back of the turn, then brightening to almost
	 * the beam's own colour at its leading edge (0deg, the top, as it turns
	 * clockwise), the same curve as the icon's.
	 */
	.sweep {
		inset: 4%;
		background: conic-gradient(
			from 0deg,
			transparent 0deg,
			transparent 195deg,
			color-mix(in oklab, var(--radar-beam) 2%, transparent) 210deg,
			color-mix(in oklab, var(--radar-beam) 9%, transparent) 240deg,
			color-mix(in oklab, var(--radar-beam) 22%, transparent) 270deg,
			color-mix(in oklab, var(--radar-beam) 40%, transparent) 300deg,
			color-mix(in oklab, var(--radar-beam) 63%, transparent) 330deg,
			color-mix(in oklab, var(--radar-beam) 80%, transparent) 350deg,
			color-mix(in oklab, var(--radar-beam) 90%, transparent) 360deg
		);
		animation: radar-sweep 2.4s linear infinite;
	}

	/* The beam: the sweep's leading edge, from the centre to the rim. */
	.sweep::after {
		position: absolute;
		top: 0;
		left: 50%;
		width: 3px;
		height: 50%;
		transform: translateX(-50%);
		border-radius: var(--radius-round);
		background: var(--radar-beam);
		content: '';
	}

	.medium .sweep::after {
		width: 2px;
	}

	.tiny .sweep::after,
	.small .sweep::after {
		width: 1.5px;
	}

	.core {
		top: 50%;
		left: 50%;
		width: 11%;
		height: 11%;
		min-width: 2px;
		min-height: 2px;
		background: var(--radar-beam);
		transform: translate(-50%, -50%);
	}

	/*
	 * Each contact sits where it does on the icon and flares as the beam
	 * reaches it: a contact at A degrees from the top is delayed by
	 * -2.4s * (1 - A / 360), so its flare starts as the beam arrives.
	 */
	.contact {
		width: 8%;
		height: 8%;
		min-width: 1.5px;
		min-height: 1.5px;
		background: var(--radar-contact);
		opacity: 0.2;
		transform: translate(-50%, -50%);
		animation: radar-contact 2.4s linear infinite;
	}

	.newest {
		top: 36.1%;
		left: 79.9%;
		width: 9.5%;
		height: 9.5%;
		animation-delay: -1.967s;
	}

	.second {
		top: 27.5%;
		left: 54.8%;
		animation-delay: -2.32s;
	}

	.faint {
		top: 23.5%;
		left: 23.5%;
		width: 7%;
		height: 7%;
		animation-delay: -0.3s;
	}

	.old {
		top: 76%;
		left: 35%;
		width: 6%;
		height: 6%;
		animation-delay: -1s;
	}

	@keyframes radar-sweep {
		to {
			transform: rotate(1turn);
		}
	}

	@keyframes radar-contact {
		0% {
			opacity: 1;
			transform: translate(-50%, -50%) scale(1.3);
		}

		12% {
			opacity: 0.9;
			transform: translate(-50%, -50%) scale(1);
		}

		75%,
		100% {
			opacity: 0.2;
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
		.contact {
			animation: none;
		}

		.contact {
			opacity: 0.8;
		}
	}
</style>

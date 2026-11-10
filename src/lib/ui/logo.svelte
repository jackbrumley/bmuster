<script lang="ts">
	import { asset } from '$app/paths';

	/**
	 * The BMuster mark (SPEC-BRAND-ICON), from the files `npm run
	 * icons:generate` builds out of docs/logo.svg. At 32px and below it shows
	 * the small version (static/favicon.svg): one ring, thicker strokes and a
	 * short sweep, because the fine detail blurs into specks at that size. The
	 * white tile reads on light and dark backgrounds, so both themes share it.
	 * Decorative: the wordmark beside it carries the name.
	 */
	let { size }: { size: number } = $props();

	const source = $derived(size <= 32 ? asset('favicon.svg') : asset('brand/bmuster-logo.svg'));
</script>

<img class="logo" src={source} width={size} height={size} alt="" />

<style>
	.logo {
		flex-shrink: 0;
	}
</style>

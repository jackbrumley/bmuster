<script lang="ts">
	import { asset } from '$app/paths';

	/**
	 * The BMuster mark (SPEC-BRAND-ICON), from the files `npm run
	 * icons:generate` builds out of docs/logo.svg: the same drawing at every
	 * size. The dark disc reads on light and dark backgrounds, so both themes
	 * share it. Decorative: the wordmark beside it carries the name.
	 */
	let { size }: { size: number } = $props();

	const source = asset('brand/bmuster-logo.svg');
</script>

<img class="logo" src={source} width={size} height={size} alt="" />

<style>
	.logo {
		flex-shrink: 0;
	}
</style>

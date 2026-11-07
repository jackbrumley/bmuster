<script lang="ts">
	import { IconDownload } from '@tabler/icons-svelte-runes';
	import Button from './button.svelte';

	/**
	 * Export in a page header (SPEC-CSV-EXPORT X1): a secondary button that
	 * downloads the list as CSV from `href`, a server export route with the
	 * page's search, filter and sort in its query. The server checks access
	 * and names the file; the page stays where it is.
	 */
	let { href }: { href: string } = $props();

	function download(): void {
		const link = document.createElement('a');
		link.href = href;
		link.download = '';
		link.click();
	}
</script>

<Button variant="secondary" size="compact" type="button" onclick={download}>
	<IconDownload size={18} /> Export
</Button>

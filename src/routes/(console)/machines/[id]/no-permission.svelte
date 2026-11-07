<script lang="ts">
	import { IconLock } from '@tabler/icons-svelte-runes';
	import EmptyState from '#lib/ui/empty-state.svelte';

	/** Shown on a machine tab the person's access rules do not allow (SPEC-ACCESS A6). */
</script>

<EmptyState
	icon={IconLock}
	title="You don't have permission for this."
	detail="An admin can give your group this permission in an access rule."
	children={undefined}
/>

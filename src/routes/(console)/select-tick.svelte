<script lang="ts">
	/**
	 * One machine's tick box in select mode (SPEC-COMMANDS C1): the whole 40 px square is the
	 * target. Named for screen readers by the machine it ticks.
	 */
	let { name, ticked, ontoggle }: { name: string; ticked: boolean; ontoggle: () => void } =
		$props();
</script>

<label class="tick">
	<input
		data-raw-input="row-select"
		type="checkbox"
		aria-label="Select {name}"
		checked={ticked}
		onchange={ontoggle}
	/>
</label>

<style>
	.tick {
		display: inline-flex;
		flex-shrink: 0;
		align-items: center;
		justify-content: center;
		width: 40px;
		height: 40px;
		cursor: pointer;
	}

	input {
		width: 20px;
		height: 20px;
		margin: 0;
		accent-color: var(--brand);
		cursor: pointer;
	}
</style>

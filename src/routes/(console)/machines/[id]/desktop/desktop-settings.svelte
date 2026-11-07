<script lang="ts">
	import {
		DESKTOP_FRAME_RATES,
		DESKTOP_QUALITIES,
		DESKTOP_SCALES,
		type DesktopQuality,
		type DesktopSettings
	} from '#lib/domain/desktop/messages.ts';
	import Panel from '#lib/ui/panel.svelte';
	import SegmentedControl from '#lib/ui/segmented-control.svelte';

	/**
	 * Quality, scale and frame rate for the stream (SPEC-DESKTOP R10). Each
	 * change goes to the agent at once as a `settings` message and applies
	 * within a frame.
	 */
	let {
		settings,
		onchange
	}: { settings: DesktopSettings; onchange: (settings: DesktopSettings) => void } = $props();

	const QUALITY_LABELS = { auto: 'Auto', low: 'Low', medium: 'Medium', high: 'High' } as const;

	const qualities = DESKTOP_QUALITIES.map((value) => ({ value, label: QUALITY_LABELS[value] }));
	const scales = DESKTOP_SCALES.map((value) => ({
		value: String(value),
		label: value === 'fit' ? 'Fit' : `${value * 100}%`
	}));
	const rates = DESKTOP_FRAME_RATES.map((value) => ({ value: String(value), label: `${value}` }));

	function pick<K extends keyof DesktopSettings>(key: K, value: DesktopSettings[K]): void {
		onchange({ ...settings, [key]: value });
	}
</script>

<Panel heading="Picture" actions={undefined} tone="normal" padding="normal">
	<div class="choices">
		<SegmentedControl
			label="Quality"
			options={qualities}
			bind:value={
				() => settings.quality,
				(value: DesktopQuality | null) => {
					if (value !== null) pick('quality', value);
				}
			}
		/>
		<SegmentedControl
			label="Scale"
			options={scales}
			bind:value={
				() => String(settings.scale),
				(value: string | null) => {
					const scale = DESKTOP_SCALES.find((candidate) => String(candidate) === value);
					if (scale !== undefined) pick('scale', scale);
				}
			}
		/>
		<SegmentedControl
			label="Frames per second, at most"
			options={rates}
			bind:value={
				() => String(settings.maxFps),
				(value: string | null) => {
					const rate = DESKTOP_FRAME_RATES.find((candidate) => String(candidate) === value);
					if (rate !== undefined) pick('maxFps', rate);
				}
			}
		/>
	</div>
</Panel>

<style>
	.choices {
		display: grid;
		gap: var(--space-4);
	}
</style>

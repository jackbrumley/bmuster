<script lang="ts">
	import {
		type AutoLevel,
		DESKTOP_FRAME_RATES,
		DESKTOP_SCALES,
		desktopQualitiesFor,
		type DesktopQuality,
		type DesktopSettings
	} from '#lib/domain/desktop/messages.ts';
	import Panel from '#lib/ui/panel.svelte';
	import SegmentedControl from '#lib/ui/segmented-control.svelte';

	/**
	 * Quality, scale and frame rate for the stream (SPEC-DESKTOP R10). Each
	 * change goes to the agent at once as a `settings` message and applies
	 * within a frame. Auto shows the level the agent picked (section 20).
	 */
	let {
		settings,
		autoLevel,
		agentVersion,
		onchange
	}: {
		settings: DesktopSettings;
		/** The level Auto picked, when it is on and the agent says; older agents never do. */
		autoLevel: AutoLevel | undefined;
		/** Which qualities the machine's agent accepts. */
		agentVersion: string;
		onchange: (settings: DesktopSettings) => void;
	} = $props();

	const QUALITY_LABELS = {
		auto: 'Auto',
		low: 'Low',
		medium: 'Medium',
		high: 'High',
		'extra-high': 'Extra high'
	} as const;

	const qualities = $derived(
		desktopQualitiesFor(agentVersion).map((value) => ({
			value,
			label:
				value === 'auto' && autoLevel !== undefined
					? `Auto (${QUALITY_LABELS[autoLevel]})`
					: QUALITY_LABELS[value]
		}))
	);
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

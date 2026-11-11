/**
 * Stay awake on mains power (SPEC-STAY-AWAKE): the inventory's power report and the line Manage
 * shows beside the switch. Browser-safe. `unreported` is an agent from before the setting.
 */
type PowerSource = 'mains' | 'battery' | 'unknown';

export type PowerReport =
	| { kind: 'unreported' }
	| {
			kind: 'reported';
			source: PowerSource;
			/** Rounded to 5; null without a battery or when the system will not say. */
			batteryPercent: number | null;
			keepAwake: 'off' | 'active' | 'waiting-for-mains';
			inhibitor: { kind: 'held' } | { kind: 'none' } | { kind: 'failed'; reason: string };
	  };

/**
 * The power source and battery level, as Overview's System card shows them (SPEC-MACHINE-DETAILS
 * D13). Shared by the page and the Machines export.
 */
export function powerSourceLabel(report: PowerReport): string {
	if (report.kind === 'unreported') {
		return 'Not reported by this agent';
	}
	const percent = report.batteryPercent;
	switch (report.source) {
		case 'mains':
			return percent === null ? 'Mains' : `Mains, battery ${percent}%`;
		case 'battery':
			return percent === null ? 'Battery' : `Battery, ${percent}%`;
		case 'unknown':
			return 'Unknown';
	}
}

export type PowerLine = { text: string; tone: 'normal' | 'warning' | 'danger' };

function battery(percent: number | null, onBattery: boolean): string {
	if (percent === null) return '';
	return onBattery ? ` (${percent}%)` : ` (battery ${percent}%)`;
}

/**
 * What the machine does now, in words. `keepAwakeOnAc` is the server's setting: when the report
 * does not match it yet, the agent has not applied (or reported) it.
 */
export function powerLine(report: PowerReport, keepAwakeOnAc: boolean): PowerLine {
	if (report.kind === 'unreported') {
		return {
			text: 'This agent is too old to report its power source or keep the machine awake; update it.',
			tone: 'warning'
		};
	}
	if (report.inhibitor.kind === 'failed') {
		return {
			text: `On mains power, but the agent could not keep the machine awake: ${report.inhibitor.reason}`,
			tone: 'danger'
		};
	}
	if ((report.keepAwake !== 'off') !== keepAwakeOnAc) {
		return {
			text: 'The agent applies the new setting and reports it at its next check-in.',
			tone: 'normal'
		};
	}
	const percent = battery(report.batteryPercent, report.source === 'battery');
	switch (report.keepAwake) {
		case 'active':
			return { text: `On mains power${percent}: staying awake`, tone: 'normal' };
		case 'waiting-for-mains':
			return report.source === 'battery'
				? { text: `On battery${percent}: sleeping normally until mains returns`, tone: 'normal' }
				: {
						text: 'The power source is unknown: sleeping normally until it reads as mains',
						tone: 'warning'
					};
		case 'off':
			switch (report.source) {
				case 'mains':
					return {
						text: `On mains power${percent}: sleeps as the machine is set to`,
						tone: 'normal'
					};
				case 'battery':
					return { text: `On battery${percent}: sleeps as the machine is set to`, tone: 'normal' };
				case 'unknown':
					return {
						text: 'The power source is unknown: sleeps as the machine is set to',
						tone: 'normal'
					};
			}
	}
}

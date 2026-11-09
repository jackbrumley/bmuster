/**
 * The machine's display report (SPEC-AGENT-LOGS 3), from the agent's inventory. Browser-safe.
 * `unreported` is an agent from before the report, which also cannot send its logs.
 */
type SeatSession =
	| { kind: 'none' }
	| {
			kind: 'active';
			sessionType: string;
			class: string;
			/** '' when neither the session leader nor logind says. */
			desktop: string;
			state: string;
			lockedHint: { kind: 'unknown' } | { kind: 'known'; locked: boolean };
	  };

type DrmCard = {
	name: string;
	/** '' when the kernel does not say. */
	driver: string;
	kms: boolean;
	connectors: { name: string; modes: string[] }[];
};

export type LinuxDisplay = {
	kind: 'linux';
	seat: SeatSession;
	cards: DrmCard[];
	uinput: { device: boolean; module: boolean };
	nvidiaModeset: { kind: 'absent' } | { kind: 'present'; value: string };
	programs: { xdgDesktopPortal: boolean; gstreamer: boolean; pipewiresrc: boolean };
	kernel: string;
	agentVersion: string;
	launcherVersion: { kind: 'none' } | { kind: 'known'; version: string };
};

export type DisplayReport =
	| LinuxDisplay
	| { kind: 'windows'; console: { kind: 'none' } | { kind: 'user'; name: string } }
	| { kind: 'unsupported' }
	| { kind: 'unreported' };

export type DisplayFact = { label: string; value: string };

function yesNo(value: boolean): string {
	return value ? 'Yes' : 'No';
}

function seatLabel(seat: SeatSession): string {
	switch (seat.kind) {
		case 'none':
			return 'No active session on seat0';
		case 'active': {
			const locked =
				seat.lockedHint.kind === 'known' ? (seat.lockedHint.locked ? ', locked' : '') : '';
			const desktop = seat.desktop === '' ? '' : ` · ${seat.desktop}`;
			return `${seat.sessionType === '' ? 'unknown' : seat.sessionType} (${seat.class}, ${seat.state}${locked})${desktop}`;
		}
	}
}

function cardLabel(card: DrmCard): string {
	const driver = card.driver === '' ? 'unknown driver' : card.driver;
	const outputs =
		card.connectors.length === 0
			? 'nothing connected'
			: card.connectors
					.map((connector) => `${connector.name} ${connector.modes[0] ?? 'no modes'}`)
					.join(', ');
	return `${driver}${card.kms ? '' : ', no KMS'} · ${outputs}`;
}

/** The Display card's facts, in display order. */
export function linuxDisplayFacts(report: LinuxDisplay): DisplayFact[] {
	return [
		{ label: 'Session', value: seatLabel(report.seat) },
		...report.cards.map((card) => ({ label: card.name, value: cardLabel(card) })),
		{
			label: 'uinput',
			value: `Device ${yesNo(report.uinput.device).toLowerCase()}, module ${yesNo(report.uinput.module).toLowerCase()}`
		},
		{
			label: 'NVIDIA modeset',
			value: report.nvidiaModeset.kind === 'present' ? report.nvidiaModeset.value : 'Not loaded'
		},
		{ label: 'Desktop portal', value: yesNo(report.programs.xdgDesktopPortal) },
		{
			label: 'GStreamer',
			value: report.programs.gstreamer
				? `Yes, pipewiresrc ${report.programs.pipewiresrc ? 'present' : 'missing'}`
				: 'No'
		},
		{ label: 'Kernel', value: report.kernel === '' ? 'Not reported' : report.kernel },
		{
			label: 'Agent',
			value: `v${report.agentVersion}${report.launcherVersion.kind === 'known' ? `, launcher v${report.launcherVersion.version}` : ', no launcher'}`
		}
	];
}

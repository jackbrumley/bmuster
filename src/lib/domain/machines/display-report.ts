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
	selinux: SeLinux;
};

type SeLinux =
	| { kind: 'unreported' }
	| { kind: 'absent' }
	| { kind: 'present'; enforcing: boolean; agentContext: string; initContext: string };

function contextLabel(context: string): string {
	return context === '' ? 'not readable' : context;
}

function selinuxFacts(selinux: SeLinux): DisplayFact[] {
	switch (selinux.kind) {
		case 'unreported':
			return [{ label: 'SELinux', value: 'Not reported by this agent' }];
		case 'absent':
			return [{ label: 'SELinux', value: 'Not enabled' }];
		case 'present':
			return [
				{ label: 'SELinux', value: selinux.enforcing ? 'Enforcing' : 'Permissive' },
				{ label: 'Agent context', value: contextLabel(selinux.agentContext) },
				{ label: 'systemd context', value: contextLabel(selinux.initContext) }
			];
	}
}

/** What a Windows desktop session depends on (SPEC-DIAGNOSTICS 4); agents before 0.4.3 leave it out. */
type WindowsSystem =
	| { kind: 'unreported' }
	| {
			kind: 'reported';
			build: string;
			edition: string;
			consoleSession: { kind: 'none' } | { kind: 'attached'; id: number; state: string };
			secureDesktop: { kind: 'unknown' } | { kind: 'known'; active: boolean };
			outputs: { adapter: string; name: string; width: number; height: number; rotation: number }[];
			sasPolicy: { kind: 'not-set' } | { kind: 'set'; value: number };
	  };

export type WindowsDisplay = {
	kind: 'windows';
	console: { kind: 'none' } | { kind: 'user'; name: string };
	system: WindowsSystem;
};

export type DisplayReport =
	LinuxDisplay | WindowsDisplay | { kind: 'unsupported' } | { kind: 'unreported' };

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
		...selinuxFacts(report.selinux),
		{
			label: 'Agent',
			value: `v${report.agentVersion}${report.launcherVersion.kind === 'known' ? `, launcher v${report.launcherVersion.version}` : ', no launcher'}`
		}
	];
}

/** `SoftwareSASGeneration`: who may send Ctrl+Alt+Del in software. */
function sasLabel(policy: { kind: 'not-set' } | { kind: 'set'; value: number }): string {
	if (policy.kind === 'not-set') return 'Not set (none)';
	switch (policy.value) {
		case 0:
			return '0 (none)';
		case 1:
			return '1 (services)';
		case 2:
			return '2 (ease of access apps)';
		case 3:
			return '3 (services and apps)';
		default:
			return String(policy.value);
	}
}

/** The Display card's facts for Windows, in display order. */
export function windowsDisplayFacts(report: WindowsDisplay): DisplayFact[] {
	const consoleUser = {
		label: 'Console user',
		value: report.console.kind === 'user' ? report.console.name : 'Nobody signed in'
	};
	const system = report.system;
	if (system.kind === 'unreported') {
		return [consoleUser, { label: 'Windows', value: 'Not reported by this agent' }];
	}
	const edition = system.edition === '' ? '' : ` ${system.edition}`;
	return [
		{
			label: 'Windows',
			value:
				system.build === '' ? `Build not reported${edition}` : `Build ${system.build}${edition}`
		},
		consoleUser,
		{
			label: 'Console session',
			value:
				system.consoleSession.kind === 'attached'
					? `${system.consoleSession.id} (${system.consoleSession.state})`
					: 'None attached'
		},
		{
			label: 'Secure desktop',
			value:
				system.secureDesktop.kind === 'known'
					? system.secureDesktop.active
						? 'Showing (sign-in, lock or UAC)'
						: 'Not showing'
					: 'Unknown'
		},
		...(system.outputs.length === 0
			? [{ label: 'Outputs', value: 'None found' }]
			: system.outputs.map((output) => ({
					label: output.name,
					value: `${output.adapter} · ${output.width}x${output.height}${output.rotation === 0 ? '' : `, rotated ${output.rotation}°`}`
				}))),
		{ label: 'SAS policy', value: sasLabel(system.sasPolicy) }
	];
}

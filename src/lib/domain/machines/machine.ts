/** What the console knows about one enrolled machine. Browser-safe: no server imports. */

export type OsFamily = 'windows' | 'linux' | 'macos';

export type MachineStatus = { kind: 'online' } | { kind: 'offline'; lastSeenIso: string };

export type SignedInUser = { kind: 'none' } | { kind: 'user'; name: string };

type Disk = { mount: string; sizeBytes: number; usedBytes: number };

/** One graphics card the agent reported (SPEC-MACHINE-DETAILS D8). `driver` is '' when unknown. */
export type Gpu = {
	name: string;
	vendor: string;
	memoryBytes: { kind: 'unknown' } | { kind: 'known'; bytes: number };
	driver: string;
};

/** The last person seen signed in at the machine (D7), kept after they sign out. */
type LastUser = { kind: 'none' } | { kind: 'user'; name: string; seenIso: string };

/** Figures from the latest check-in (or the live socket while someone is watching). */
export type LiveFigures =
	| { kind: 'none' }
	| {
			kind: 'known';
			cpuPercent: number;
			memoryUsedBytes: number;
			uptimeSeconds: number;
			signedInUser: SignedInUser;
	  };

/** The latest full inventory, or `pending` until the first check-in sends it. */
export type MachineInventory =
	| { kind: 'pending' }
	| {
			kind: 'known';
			osName: string;
			osVersion: string;
			osBuild: string;
			updates: { kind: 'unknown' } | { kind: 'known'; count: number };
			cpuModel: string;
			cpuCores: number;
			memoryTotalBytes: number;
			disks: Disk[];
			displayCount: number;
			addresses: string[];
			gpus: Gpu[];
	  };

export type Machine = {
	id: string;
	name: string;
	/** Plain text from the admins; '' when none was written. */
	description: string;
	hostname: string;
	osFamily: OsFamily;
	/** The agent build it runs, e.g. `x86_64-unknown-linux-gnu`. */
	target: string;
	agentVersion: string;
	status: MachineStatus;
	lastUser: LastUser;
	live: LiveFigures;
	inventory: MachineInventory;
	enrolledIso: string;
	lastSeenIso: string;
};

export type ShellChoice = { id: string; label: string };

/** The shells a terminal session can start, per operating system. */
export function shellsFor(family: OsFamily): ShellChoice[] {
	switch (family) {
		case 'windows':
			return [
				{ id: 'powershell', label: 'PowerShell' },
				{ id: 'cmd', label: 'Command Prompt' }
			];
		case 'linux':
			return [
				{ id: 'bash', label: 'bash' },
				{ id: 'sh', label: 'sh' }
			];
		case 'macos':
			return [
				{ id: 'zsh', label: 'zsh' },
				{ id: 'bash', label: 'bash' }
			];
	}
}

/** The operating system's name for display, before and after inventory arrives. */
export function osLabel(machine: Machine): string {
	if (machine.inventory.kind === 'known') {
		return `${machine.inventory.osName} ${machine.inventory.osVersion}`.trim();
	}
	switch (machine.osFamily) {
		case 'windows':
			return 'Windows';
		case 'linux':
			return 'Linux';
		case 'macos':
			return 'macOS';
	}
}

/** Who is signed in at the machine, from the latest figures. */
export function signedInUserOf(machine: Machine): SignedInUser {
	return machine.live.kind === 'known' ? machine.live.signedInUser : { kind: 'none' };
}

/** Machines list search (D6): name, hostname, description and operating system, any case. */
export function matchesSearch(machine: Machine, query: string): boolean {
	const wanted = query.trim().toLowerCase();
	if (wanted === '') {
		return true;
	}
	return [machine.name, machine.hostname, machine.description, osLabel(machine)].some((field) =>
		field.toLowerCase().includes(wanted)
	);
}

/** What the console knows about one enrolled machine. Browser-safe: no server imports. */
import { formatBytes } from '#lib/utils/format.ts';
import type { SessionInUse, TerminalShell } from '../sessions/session.ts';
import type { MachineUpdateState } from './agent-updates.ts';
import type { DisplayReport } from './display-report.ts';
import type { PowerReport } from './power.ts';
import type { LowDisk } from '../storage/storage.ts';

export type OsFamily = 'windows' | 'linux' | 'macos';

/**
 * Online, reconnecting or offline (SPEC-PRESENCE P9). `sinceIso` is when it was last connected:
 * when its live socket closed, or its last check-in for an agent without one. A machine is
 * reconnecting while its socket has been gone for less than the grace, then offline.
 */
export type MachineStatus =
	| { kind: 'online' }
	| { kind: 'reconnecting'; sinceIso: string }
	| { kind: 'offline'; sinceIso: string };

/** What the badge and the export call a status (P9). */
export function statusLabel(status: MachineStatus): 'Online' | 'Reconnecting' | 'Offline' {
	switch (status.kind) {
		case 'online':
			return 'Online';
		case 'reconnecting':
			return 'Reconnecting';
		case 'offline':
			return 'Offline';
	}
}

export type SignedInUser = { kind: 'none' } | { kind: 'user'; name: string };

type Disk = { mount: string; sizeBytes: number; usedBytes: number };

/** One graphics card the agent reported (SPEC-MACHINE-DETAILS D8). `driver` is '' when unknown. */
export type Gpu = {
	name: string;
	vendor: string;
	memoryBytes: { kind: 'unknown' } | { kind: 'known'; bytes: number };
	driver: string;
};

/**
 * "NVIDIA GeForce RTX 4070 (12 GB)": the card, with its video memory when known (D8). Shared by
 * the Overview and the Machines export.
 */
export function gpuLabel(gpu: Gpu): string {
	if (gpu.memoryBytes.kind === 'unknown') {
		return gpu.name;
	}
	// Video memory comes in whole gigabytes on any card that has that much.
	const bytes = gpu.memoryBytes.bytes;
	const gigabytes = bytes / 1024 ** 3;
	return `${gpu.name} (${gigabytes >= 1 ? `${Math.round(gigabytes)} GB` : formatBytes(bytes)})`;
}

/**
 * One network adapter with addresses (SPEC-MACHINE-DETAILS D10). `mac` is '' or all zeros when the
 * system gives none (a tunnel, for one).
 */
export type NetworkAdapter = { name: string; mac: string; addresses: string[] };

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
			network: NetworkAdapter[];
			gpus: Gpu[];
			/** What a remote desktop depends on (SPEC-AGENT-LOGS 3). */
			display: DisplayReport;
			/** The power source and whether the agent keeps it awake (SPEC-STAY-AWAKE). */
			power: PowerReport;
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
	/** Whether its agent is up to date, updating, rolled back or pinned (SPEC-AGENT-UPDATES). */
	update: MachineUpdateState;
	status: MachineStatus;
	lastUser: LastUser;
	live: LiveFigures;
	inventory: MachineInventory;
	enrolledIso: string;
	lastSeenIso: string;
	/** Sessions open on it right now (SPEC-SESSIONS T8). */
	inUse: SessionInUse[];
	/** Drives at 90 % used or more (SPEC-STORAGE 12), fullest first; empty when none. */
	lowDisk: LowDisk[];
};

export type ShellChoice = { id: TerminalShell; label: string };

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

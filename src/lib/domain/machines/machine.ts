/** What the console knows about one enrolled machine. Browser-safe: no server imports. */

export type OsFamily = 'windows' | 'linux' | 'macos';

export type MachineStatus =
	{ kind: 'online'; sinceIso: string } | { kind: 'offline'; lastSeenIso: string };

type SignedInUser = { kind: 'none' } | { kind: 'user'; name: string };

type Disk = {
	mount: string;
	sizeBytes: number;
	usedBytes: number;
};

export type Machine = {
	id: string;
	name: string;
	hostname: string;
	os: {
		family: OsFamily;
		name: string;
		version: string;
		updatesPending: number;
	};
	status: MachineStatus;
	signedInUser: SignedInUser;
	ipAddress: string;
	agentVersion: string;
	cpu: { model: string; cores: number; loadPercent: number };
	memory: { totalBytes: number; usedBytes: number };
	disks: Disk[];
	displays: number;
	tags: string[];
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

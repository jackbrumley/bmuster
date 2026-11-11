/**
 * Storage (SPEC-STORAGE), as the console sees it: where a machine's disk
 * space went, from the agent's background scan. Browser-safe shapes shared by
 * the server and the page, and the pure rules the page uses. The agent's side
 * is agent/crates/protocol/src/storage.rs.
 */
import { formatRelative } from '#lib/utils/format.ts';
import type { Crumb } from '../files/files.ts';

/** A drive's last complete scan. */
type LastScan =
	| { kind: 'none' }
	| {
			kind: 'complete';
			startedAtMs: number;
			finishedAtMs: number;
			/** What the scan counted; used space minus this was not seen. */
			scannedBytes: number;
			usedBytes: number;
			files: number;
			folders: number;
			denied: number;
	  };

type Scanning = { kind: 'idle' } | { kind: 'running'; startedAtMs: number; percent: number };

/** One scanned drive: live size and free space, and its scan state. */
export type DriveSummary = {
	mount: string;
	sizeBytes: number;
	freeBytes: number;
	lastScan: LastScan;
	scanning: Scanning;
};

type StorageProblem = { kind: 'none' } | { kind: 'failed'; message: string; atMs: number };

export type StorageSummary = { drives: DriveSummary[]; problem: StorageProblem };

export type FolderChild = {
	name: string;
	path: string;
	bytes: number;
	files: number;
	hasChildren: boolean;
};

/** One scanned folder, its kept sub-folders biggest first. */
export type FolderView = {
	mount: string;
	path: string;
	finishedAtMs: number;
	bytes: number;
	files: number;
	ownBytes: number;
	ownFiles: number;
	foldedFolders: number;
	foldedBytes: number;
	/** At the drive's root: used space the scan did not see. */
	notScannedBytes: number;
	children: FolderChild[];
	offset: number;
	more: boolean;
};

export type LargeFile = { path: string; bytes: number; modifiedMs: number | null };

/** The last summary a machine reported in its check-in (SPEC-STORAGE 6). */
export type ReportedStorage =
	{ kind: 'none' } | { kind: 'reported'; drives: DriveSummary[]; reportedAt: string };

/** A part's share of a whole, 0 to 100. */
export function shareOf(bytes: number, total: number): number {
	return total <= 0 ? 0 : Math.min(100, Math.round((bytes / total) * 100));
}

/**
 * "Drives › / › var › log": the first lists the drives, then the drive at
 * `mount`, then each folder down to `path`, joined with the machine's own
 * separator (a Windows drive's mount ends with `\`).
 */
export function storageCrumbs(mount: string, path: string): Crumb[] {
	const crumbs: Crumb[] = [
		{ label: 'Drives', target: { kind: 'roots' } },
		{ label: mount, target: { kind: 'folder', path: mount } }
	];
	if (!path.startsWith(mount)) {
		return crumbs;
	}
	const separator = mount.includes('\\') ? '\\' : '/';
	const parts = path
		.slice(mount.length)
		.split(/[\\/]/)
		.filter((part) => part.length > 0);
	let at = mount;
	for (const part of parts) {
		at = at.endsWith(separator) ? `${at}${part}` : `${at}${separator}${part}`;
		crumbs.push({ label: part, target: { kind: 'folder', path: at } });
	}
	return crumbs;
}

/** "Scanned 3 h ago", "Scanning… 42 %", or both while a rescan runs. */
export function scanLine(drive: DriveSummary, now: number): string {
	const scanned =
		drive.lastScan.kind === 'complete'
			? `Scanned ${formatRelative(new Date(drive.lastScan.finishedAtMs).toISOString(), now)}`
			: 'Not scanned yet';
	switch (drive.scanning.kind) {
		case 'idle':
			return scanned;
		case 'running':
			return drive.lastScan.kind === 'complete'
				? `${scanned} · scanning again, ${drive.scanning.percent} %`
				: `Scanning… ${drive.scanning.percent} %`;
	}
}

/** A file path as its folder and its name, for the largest files list. */
export function splitFilePath(path: string): { folder: string; name: string } {
	const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
	if (cut < 0) {
		return { folder: '', name: path };
	}
	const folder = path.slice(0, cut);
	// The root keeps its separator: `/` and `C:\`.
	const atRoot = folder.length === 0 || folder.endsWith(':');
	return { folder: atRoot ? path.slice(0, cut + 1) : folder, name: path.slice(cut + 1) };
}

/** A drive this full or fuller is nearly full (SPEC-STORAGE 12). */
const LOW_DISK_PERCENT = 90;
/** A nearly full drive's alert is raised again only after it drops below this. */
const LOW_DISK_CLEAR_PERCENT = 85;

/** A nearly full drive: its mount, whole percent used (rounded down) and free bytes. */
export type LowDisk = { mount: string; percent: number; freeBytes: number };

type DriveSpace = { mount: string; sizeBytes: number; freeBytes: number };

function usedShare(drive: DriveSpace): number {
	return drive.sizeBytes <= 0 ? 0 : ((drive.sizeBytes - drive.freeBytes) / drive.sizeBytes) * 100;
}

/** The drives at 90 % used or more, fullest first. */
export function lowDiskDrives(drives: readonly DriveSpace[]): LowDisk[] {
	return drives
		.filter((drive) => usedShare(drive) >= LOW_DISK_PERCENT)
		.map((drive) => ({
			mount: drive.mount,
			percent: Math.floor(usedShare(drive)),
			freeBytes: drive.freeBytes
		}))
		.sort((a, b) => b.percent - a.percent);
}

/** "C:\ 94 %, D:\ 91 %": the Machines list's tag. */
export function lowDiskText(drives: readonly LowDisk[]): string {
	return drives.map((drive) => `${drive.mount} ${drive.percent} %`).join(', ');
}

/**
 * The Disk nearly full notifications to raise now (SPEC-STORAGE 12): once when a drive reaches
 * 90 %, again only after it dropped below 85 % and reached 90 % again. `alerted` are the mounts
 * alerted and not yet cleared; a drive that is gone is forgotten.
 */
export function lowDiskAlerts(
	drives: readonly DriveSpace[],
	alerted: readonly string[]
): { alerted: string[]; raise: LowDisk[] } {
	const raise = lowDiskDrives(drives).filter((drive) => !alerted.includes(drive.mount));
	const still = drives
		.filter((drive) => alerted.includes(drive.mount) && usedShare(drive) >= LOW_DISK_CLEAR_PERCENT)
		.map((drive) => drive.mount);
	return { alerted: [...still, ...raise.map((drive) => drive.mount)].sort(), raise };
}

/**
 * Storage clean-up (SPEC-STORAGE 11), as the console sees it: the fixed list of items, their
 * sizes, a run's progress and results, and the words for them. Browser-safe. The agent's side is
 * agent/crates/protocol/src/cleanup.rs; only item ids cross the wire, never a path.
 */
import { formatBytes } from '#lib/utils/format.ts';

export const CLEANUP_ITEM_IDS = [
	'windows-user-temp',
	'windows-temp',
	'windows-update-cache',
	'delivery-optimisation-cache',
	'windows-crash-dumps',
	'recycle-bins',
	'component-store',
	'package-cache',
	'journal',
	'linux-crash-dumps',
	'old-var-tmp',
	'unused-flatpaks',
	'thumbnail-caches'
] as const;

export type CleanupItemId = (typeof CLEANUP_ITEM_IDS)[number];

type CatalogueEntry = { label: string; explanation: string };

/** What each item is called and what it deletes, in plain words. */
export const CLEANUP_CATALOGUE: Record<CleanupItemId, CatalogueEntry> = {
	'windows-user-temp': {
		label: 'Temporary files of each user',
		explanation:
			"Files older than 7 days in each person's temporary folder (AppData\\Local\\Temp). Files in use are skipped."
	},
	'windows-temp': {
		label: 'Windows temporary files',
		explanation: 'Files older than 7 days in the Windows Temp folder. Files in use are skipped.'
	},
	'windows-update-cache': {
		label: 'Windows Update downloads',
		explanation:
			'Update files Windows has already downloaded. Windows downloads them again if it needs them; files of an update in progress are skipped.'
	},
	'delivery-optimisation-cache': {
		label: 'Delivery Optimisation cache',
		explanation: 'Update pieces Windows keeps to share with other computers.'
	},
	'windows-crash-dumps': {
		label: 'Crash dumps',
		explanation:
			'Memory dumps written when Windows or a program crashed (Minidump, MEMORY.DMP, CrashDumps).'
	},
	'recycle-bins': {
		label: 'Recycle Bins',
		explanation: "Everything in every person's Recycle Bin on each local drive."
	},
	'component-store': {
		label: 'Windows component clean-up',
		explanation:
			'Removes replaced versions of Windows components (DISM StartComponentCleanup). Updates installed so far can no longer be uninstalled.'
	},
	'package-cache': {
		label: 'Package downloads',
		explanation:
			'Packages apt or dnf downloaded to install. They are downloaded again if needed (apt-get clean, dnf clean packages).'
	},
	journal: {
		label: 'System journal over 200 MB',
		explanation: 'Older system log entries, keeping the newest 200 MB (journalctl --vacuum-size).'
	},
	'linux-crash-dumps': {
		label: 'Crash dumps',
		explanation: 'Core dumps and crash reports of programs that crashed.'
	},
	'old-var-tmp': {
		label: 'Old files in /var/tmp',
		explanation: 'Files nobody has read or changed for 30 days.'
	},
	'unused-flatpaks': {
		label: 'Unused Flatpak runtimes',
		explanation: 'Runtimes no installed Flatpak app needs any more (flatpak uninstall --unused).'
	},
	'thumbnail-caches': {
		label: 'Thumbnail caches',
		explanation:
			"Picture previews in each person's ~/.cache/thumbnails. They are made again when needed."
	}
};

export type CleanupSize = { kind: 'bytes'; bytes: number; files: number } | { kind: 'unknown' };

export type CleanupItemSize = { id: CleanupItemId; size: CleanupSize };

export type CleanupItemResult = {
	freedBytes: number;
	/** `free-space`: the drive's free space after minus before. */
	measured: 'counted' | 'free-space';
	filesRemoved: number;
	filesSkipped: number;
	errors: number;
	messages: string[];
};

type CleanupItemState =
	| { kind: 'waiting' }
	| { kind: 'running'; freedBytes: number; filesRemoved: number }
	| { kind: 'done'; result: CleanupItemResult };

export type CleanupItemProgress = { id: CleanupItemId; state: CleanupItemState };

export type CleanupRun =
	| { kind: 'none' }
	| { kind: 'running'; runId: string; startedAtMs: number; items: CleanupItemProgress[] }
	| {
			kind: 'finished';
			runId: string;
			startedAtMs: number;
			finishedAtMs: number;
			items: CleanupItemProgress[];
	  }
	| { kind: 'interrupted'; runId: string; startedAtMs: number; items: CleanupItemProgress[] };

export function cleanupLabel(id: CleanupItemId): string {
	return CLEANUP_CATALOGUE[id].label;
}

/** "2.1 GB in 4,210 files", or the unknown amount. */
export function sizeText(size: CleanupSize): string {
	switch (size.kind) {
		case 'bytes':
			return size.files === 0
				? 'Nothing to clean up'
				: `${formatBytes(size.bytes)} in ${new Intl.NumberFormat('en-AU').format(size.files)} ${size.files === 1 ? 'file' : 'files'}`;
		case 'unknown':
			return 'Frees an unknown amount, can take several minutes';
	}
}

/** "3 items, 4.6 GB selected", with the unknown amount when one such item is ticked. */
export function selectionText(
	sizes: readonly CleanupItemSize[],
	ticked: ReadonlySet<CleanupItemId>
): string {
	const chosen = sizes.filter((item) => ticked.has(item.id));
	if (chosen.length === 0) {
		return 'Nothing selected';
	}
	const bytes = chosen.reduce(
		(sum, item) => sum + (item.size.kind === 'bytes' ? item.size.bytes : 0),
		0
	);
	const unknown = chosen.some((item) => item.size.kind === 'unknown');
	const count = `${chosen.length} ${chosen.length === 1 ? 'item' : 'items'}`;
	return `${count}, ${formatBytes(bytes)}${unknown ? ' plus an unknown amount' : ''} selected`;
}

/** The confirmation's words: every ticked item with its size. */
export function confirmText(
	sizes: readonly CleanupItemSize[],
	ticked: ReadonlySet<CleanupItemId>
): string {
	const lines = sizes
		.filter((item) => ticked.has(item.id))
		.map((item) => `${cleanupLabel(item.id)}: ${sizeText(item.size)}.`);
	return `${lines.join(' ')} The files are deleted for good; files in use are skipped.`;
}

/** "Freed 1.9 GB · 4,100 files removed · 110 skipped". */
export function resultText(result: CleanupItemResult): string {
	const number = new Intl.NumberFormat('en-AU');
	const freed = `${result.measured === 'free-space' ? 'Freed about' : 'Freed'} ${formatBytes(result.freedBytes)}`;
	const parts = [freed];
	if (result.measured === 'counted') {
		parts.push(
			`${number.format(result.filesRemoved)} ${result.filesRemoved === 1 ? 'file' : 'files'} removed`
		);
	}
	if (result.filesSkipped > 0) {
		parts.push(`${number.format(result.filesSkipped)} skipped`);
	}
	if (result.errors > 0) {
		parts.push(`${number.format(result.errors)} ${result.errors === 1 ? 'error' : 'errors'}`);
	}
	return parts.join(' · ');
}

/** The run's totals over the items that finished. */
export function runTotals(items: readonly CleanupItemProgress[]): {
	freedBytes: number;
	filesRemoved: number;
	filesSkipped: number;
	errors: number;
} {
	return items.reduce(
		(sum, item) =>
			item.state.kind === 'done'
				? {
						freedBytes: sum.freedBytes + item.state.result.freedBytes,
						filesRemoved: sum.filesRemoved + item.state.result.filesRemoved,
						filesSkipped: sum.filesSkipped + item.state.result.filesSkipped,
						errors: sum.errors + item.state.result.errors
					}
				: sum,
		{ freedBytes: 0, filesRemoved: 0, filesSkipped: 0, errors: 0 }
	);
}

/** The `storage-cleanup` audit entry's detail, in plain words (S24). */
export function cleanupAuditDetail(
	items: readonly CleanupItemProgress[],
	outcome: 'finished' | 'interrupted'
): Record<string, string> {
	const totals = runTotals(items);
	const number = new Intl.NumberFormat('en-AU');
	return {
		items: items.map((item) => cleanupLabel(item.id)).join(', '),
		freed: formatBytes(totals.freedBytes),
		'files removed': number.format(totals.filesRemoved),
		'files skipped': number.format(totals.filesSkipped),
		errors: number.format(totals.errors),
		result: outcome === 'finished' ? 'Finished' : 'Stopped before the end'
	};
}

/** The `storage-cleanup-started` audit entry's detail. */
export function cleanupStartDetail(items: readonly CleanupItemId[]): Record<string, string> {
	return { items: items.map(cleanupLabel).join(', ') };
}

/**
 * The Files tab (SPEC-FILES), as the console sees it. Browser-safe: shapes
 * shared by the server and the page, and the pure rules for paths, names,
 * breadcrumbs and sorting. The agent's side is agent/crates/protocol/src/files.rs.
 */
import type { OsFamily } from '../machines/machine.ts';

export const ENTRY_KINDS = ['file', 'folder', 'link', 'other'] as const;
type EntryKind = (typeof ENTRY_KINDS)[number];

/** One entry of a folder. Links are shown as links, never followed. */
export type FileEntry = {
	name: string;
	kind: EntryKind;
	/** Bytes, for files; 0 for everything else. */
	size: number;
	modifiedMs: number | null;
	hidden: boolean;
	linkTarget: string | null;
};

/** A drive (Windows) or a mounted file system. */
export type FileRoot = {
	path: string;
	label: string;
	kind: 'drive' | 'mount';
	totalBytes: number | null;
	freeBytes: number | null;
};

export type FolderListing = { path: string; entries: FileEntry[]; more: boolean };

/** A listing stops here; the page says "Showing the first 5,000". */
export const MAX_LIST_ENTRIES = 5000;

/** Uploads go in pieces of this size (adapter-node's body limit is 16 MB). */
export const UPLOAD_CHUNK_BYTES = 8 * 1024 * 1024;

/** Why the agent refused a request. */
export const FILE_ERROR_CODES = [
	'invalid',
	'not-found',
	'exists',
	'not-empty',
	'denied',
	'no-space',
	'offset',
	'mismatch',
	'busy',
	'io'
] as const;
export type FileErrorCode = (typeof FILE_ERROR_CODES)[number];

/** Whose path rules apply on a machine. */
export type PathFlavour = 'windows' | 'unix';

export function pathFlavour(osFamily: OsFamily): PathFlavour {
	return osFamily === 'windows' ? 'windows' : 'unix';
}

function separator(flavour: PathFlavour): string {
	return flavour === 'windows' ? '\\' : '/';
}

/** The parts of an absolute path after its root (`C:\` or `/`). */
function partsOf(flavour: PathFlavour, path: string): { root: string; parts: string[] } {
	if (flavour === 'windows') {
		const root = `${path.slice(0, 2).toUpperCase()}\\`;
		return {
			root,
			parts: path
				.slice(3)
				.split(/[\\/]/)
				.filter((part) => part !== '')
		};
	}
	return { root: '/', parts: path.split('/').filter((part) => part !== '') };
}

export function joinPath(flavour: PathFlavour, dir: string, name: string): string {
	const { root, parts } = partsOf(flavour, dir);
	return root + [...parts, name].join(separator(flavour));
}

/** The folder holding `path`, or undefined at a root. */
export function parentPath(flavour: PathFlavour, path: string): string | undefined {
	const { root, parts } = partsOf(flavour, path);
	if (parts.length === 0) {
		return undefined;
	}
	return root + parts.slice(0, -1).join(separator(flavour));
}

/** The last part of a path: what a download is called. */
export function baseName(flavour: PathFlavour, path: string): string {
	const { root, parts } = partsOf(flavour, path);
	return parts.at(-1) ?? root;
}

export type Crumb = { label: string; target: { kind: 'roots' } | { kind: 'folder'; path: string } };

/** "This PC › C: › Users" or "Disks › / › home": each part opens that folder; the first lists the roots. */
export function breadcrumbs(flavour: PathFlavour, path: string): Crumb[] {
	const { root, parts } = partsOf(flavour, path);
	const crumbs: Crumb[] =
		flavour === 'windows'
			? [
					{ label: 'This PC', target: { kind: 'roots' } },
					{ label: root.slice(0, 2), target: { kind: 'folder', path: root } }
				]
			: [
					{ label: 'Disks', target: { kind: 'roots' } },
					{ label: '/', target: { kind: 'folder', path: root } }
				];
	parts.forEach((part, index) => {
		crumbs.push({
			label: part,
			target: {
				kind: 'folder',
				path: root + parts.slice(0, index + 1).join(separator(flavour))
			}
		});
	});
	return crumbs;
}

export const FILE_SORTS = ['name', 'date', 'size'] as const;
export type FileSort = (typeof FILE_SORTS)[number];

/** Folders first, then by the chosen order; hidden entries only when asked for. */
export function arrangeEntries(
	entries: readonly FileEntry[],
	sort: FileSort,
	showHidden: boolean
): FileEntry[] {
	const byName = (a: FileEntry, b: FileEntry): number =>
		a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
	const order = (a: FileEntry, b: FileEntry): number => {
		switch (sort) {
			case 'name':
				return byName(a, b);
			case 'date':
				return (b.modifiedMs ?? 0) - (a.modifiedMs ?? 0) || byName(a, b);
			case 'size':
				return b.size - a.size || byName(a, b);
		}
	};
	const isFolder = (entry: FileEntry): number => (entry.kind === 'folder' ? 0 : 1);
	return entries
		.filter((entry) => showHidden || !entry.hidden)
		.toSorted((a, b) => isFolder(a) - isFolder(b) || order(a, b));
}

const RESERVED_WINDOWS = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³]|conin\$|conout\$)(\..*)?$/i;

/**
 * Why a name for a new file or folder is not allowed, or undefined. The
 * agent checks again with the same rules (agent `files::paths`).
 */
export function newNameProblem(flavour: PathFlavour, name: string): string | undefined {
	if (name.trim() === '') {
		return 'Type a name.';
	}
	if (name === '.' || name === '..') {
		return 'That is not a name.';
	}
	if (new TextEncoder().encode(name).byteLength > 255) {
		return 'That name is too long.';
	}
	if (/[/\\\0]/.test(name)) {
		return 'A name cannot contain / or \\.';
	}
	if (name.includes(':')) {
		return 'A name cannot contain a colon.';
	}
	if (/\p{Cc}/u.test(name)) {
		return 'A name cannot contain control characters.';
	}
	if (flavour === 'windows') {
		if (/[<>"|?*]/.test(name)) {
			return 'On Windows a name cannot contain < > " | ? or *.';
		}
		if (name.endsWith('.') || name.endsWith(' ')) {
			return 'On Windows a name cannot end with a dot or a space.';
		}
		if (RESERVED_WINDOWS.test(name.trimEnd())) {
			return `${name} is a reserved name on Windows.`;
		}
	}
	return undefined;
}

<script lang="ts">
	import { onMount } from 'svelte';
	import { SvelteSet } from 'svelte/reactivity';
	import { IconAlertTriangle, IconFileUpload, IconFolderPlus } from '@tabler/icons-svelte-runes';
	import {
		arrangeEntries,
		breadcrumbs,
		FILE_SORTS,
		joinPath,
		pathFlavour,
		type Crumb,
		type FileEntry,
		type FileRoot,
		type FileSort,
		type FolderListing
	} from '#lib/domain/files/files.ts';
	import type { Machine } from '#lib/domain/machines/machine.ts';
	import Button from '#lib/ui/button.svelte';
	import Checkbox from '#lib/ui/checkbox.svelte';
	import ChipGroup from '#lib/ui/chip-group.svelte';
	import { confirmAction, confirmByTyping } from '#lib/ui/confirm-action.svelte.ts';
	import EmptyState from '#lib/ui/empty-state.svelte';
	import LoadingVeil from '#lib/ui/loading-veil.svelte';
	import { showToast } from '#lib/ui/toast.svelte.ts';
	import BreadcrumbBar from './breadcrumb-bar.svelte';
	import EntryList from './entry-list.svelte';
	import EntrySheet from './entry-sheet.svelte';
	import { filesApi } from './files-api.ts';
	import NameDialog from './name-dialog.svelte';
	import RootList from './root-list.svelte';
	import SelectionBar from './selection-bar.svelte';
	import UploadTray from './upload-tray.svelte';
	import { UploadQueue } from './upload-queue.svelte.ts';

	/**
	 * The machine's files (SPEC-FILES): drives, folders, downloads through
	 * the browser's own download manager, resumable uploads, new folders,
	 * renames and deletes. Everything runs on the machine as the agent; the
	 * server checks the `files` permission on every request.
	 */
	let { machine }: { machine: Machine } = $props();

	type View = { kind: 'roots' } | { kind: 'folder'; path: string };
	type Loaded<T> =
		{ kind: 'loading' } | { kind: 'ready'; value: T } | { kind: 'failed'; message: string };
	type Naming = { kind: 'none' } | { kind: 'new-folder' } | { kind: 'rename'; entry: FileEntry };

	const flavour = $derived(pathFlavour(machine.osFamily));
	const api = $derived(filesApi(machine.id));
	const storageKey = $derived(`bmuster.files.${machine.id}`);

	let view = $state<View>({ kind: 'roots' });
	let roots = $state<Loaded<FileRoot[]>>({ kind: 'loading' });
	let listing = $state<Loaded<FolderListing>>({ kind: 'loading' });
	let sort = $state<FileSort>('name');
	let showHidden = $state(false);
	let sheet = $state<FileEntry>();
	let naming = $state<Naming>({ kind: 'none' });
	let picker = $state<HTMLInputElement>();
	const selected = new SvelteSet<string>();
	let loads = 0;

	const queue = new UploadQueue(
		{
			beginUpload: (...args) => api.beginUpload(...args),
			uploadChunk: (...args) => api.uploadChunk(...args),
			endUpload: (...args) => api.endUpload(...args),
			cancelUpload: (...args) => api.cancelUpload(...args)
		},
		{
			finished: (upload) => {
				showToast(`${upload.name} uploaded.`, 'success');
				if (view.kind === 'folder' && view.path === upload.dir) {
					void load(view);
				}
			},
			wait: (ms) =>
				new Promise((resolve) => {
					setTimeout(resolve, ms);
				})
		}
	);

	const rootsCrumb: Crumb = $derived({
		label: flavour === 'windows' ? 'This PC' : 'Disks',
		target: { kind: 'roots' }
	});
	const crumbs = $derived(view.kind === 'folder' ? breadcrumbs(flavour, view.path) : [rootsCrumb]);
	const entries = $derived(
		listing.kind === 'ready' ? arrangeEntries(listing.value.entries, sort, showHidden) : []
	);
	const allSelected = $derived(
		entries.length > 0 && entries.every((entry) => selected.has(entry.name))
	);
	const sortOptions = FILE_SORTS.map((value) => ({
		value,
		label: value === 'name' ? 'Name' : value === 'date' ? 'Date' : 'Size',
		count: undefined
	}));

	onMount(() => {
		let start: View = flavour === 'windows' ? { kind: 'roots' } : { kind: 'folder', path: '/' };
		try {
			const saved = sessionStorage.getItem(storageKey);
			if (saved !== null) {
				start = { kind: 'folder', path: saved };
			}
		} catch {
			// No storage (a private window): start at the top.
		}
		void open(start);
	});

	async function load(target: View): Promise<void> {
		loads += 1;
		const mine = loads;
		if (target.kind === 'roots') {
			roots = { kind: 'loading' };
			const result = await api.roots();
			if (mine === loads) {
				roots = result.ok
					? { kind: 'ready', value: result.data.roots }
					: { kind: 'failed', message: result.message };
			}
			return;
		}
		if (listing.kind === 'failed') {
			listing = { kind: 'loading' };
		}
		const result = await api.list(target.path);
		if (mine === loads) {
			listing = result.ok
				? { kind: 'ready', value: result.data }
				: { kind: 'failed', message: result.message };
		}
	}

	async function open(target: View): Promise<void> {
		const changed =
			target.kind !== view.kind ||
			(target.kind === 'folder' && view.kind === 'folder' && target.path !== view.path);
		view = target;
		if (changed) {
			selected.clear();
			listing = { kind: 'loading' };
		}
		try {
			if (target.kind === 'folder') {
				sessionStorage.setItem(storageKey, target.path);
			} else {
				sessionStorage.removeItem(storageKey);
			}
		} catch {
			// No storage: the tab starts at the top next time.
		}
		await load(target);
	}

	function pathOf(entry: FileEntry): string {
		return view.kind === 'folder' ? joinPath(flavour, view.path, entry.name) : entry.name;
	}

	function openEntry(entry: FileEntry): void {
		if (entry.kind === 'folder') {
			void open({ kind: 'folder', path: pathOf(entry) });
		} else {
			sheet = entry;
		}
	}

	function pickCrumb(target: Crumb['target']): void {
		void open(target);
	}

	function openRoot(path: string): void {
		void open({ kind: 'folder', path });
	}

	function setSort(value: FileSort | null): void {
		if (value !== null) {
			sort = value;
		}
	}

	function openLinkedFolder(entry: FileEntry): void {
		sheet = undefined;
		void open({ kind: 'folder', path: pathOf(entry) });
	}

	function renameFromSheet(entry: FileEntry): void {
		sheet = undefined;
		naming = { kind: 'rename', entry };
	}

	function deleteFromSheet(entry: FileEntry): void {
		void remove([entry.name]);
	}

	function toggle(name: string, on: boolean): void {
		if (on) {
			selected.add(name);
		} else {
			selected.delete(name);
		}
	}

	function selectAll(on: boolean): void {
		selected.clear();
		if (on) {
			for (const entry of entries) {
				selected.add(entry.name);
			}
		}
	}

	/** Hands the file to the browser's own download manager, which shows progress and resumes. */
	function startDownload(entry: FileEntry): void {
		const link = document.createElement('a');
		link.href = api.downloadUrl(pathOf(entry));
		link.download = entry.name;
		link.rel = 'noopener';
		document.body.append(link);
		link.click();
		link.remove();
	}

	function download(entry: FileEntry): void {
		sheet = undefined;
		startDownload(entry);
	}

	async function downloadSelected(): Promise<void> {
		const chosen = entries.filter((entry) => selected.has(entry.name));
		const files = chosen.filter((entry) => entry.kind === 'file' || entry.kind === 'link');
		if (files.length < chosen.length) {
			showToast('Folders cannot be downloaded yet; their files can.', 'error');
		}
		for (const [index, entry] of files.entries()) {
			if (index > 0) {
				// One at a time, so the browser does not take a burst for a pop-up.
				await new Promise((resolve) => setTimeout(resolve, 400));
			}
			startDownload(entry);
		}
	}

	async function remove(names: readonly string[]): Promise<void> {
		if (view.kind !== 'folder' || names.length === 0) {
			return;
		}
		const dir = view.path;
		const chosen = entries.filter((entry) => names.includes(entry.name));
		const folders = chosen.filter((entry) => entry.kind === 'folder');
		const what = names.length === 1 ? `“${names[0] ?? ''}”` : `${names.length} items`;
		const yes =
			folders.length > 0
				? await confirmByTyping({
						title: `Delete ${what}?`,
						message: `${folders.length === 1 ? 'The folder is' : `${folders.length} folders are`} deleted with everything in them, on the machine, straight away. There is no undo.`,
						confirmLabel: 'Delete',
						text: names.length === 1 ? (names[0] ?? '') : `delete ${names.length}`
					})
				: await confirmAction({
						title: `Delete ${what}?`,
						message:
							'They are deleted on the machine straight away. There is no undo. A link is deleted, not what it points to.',
						confirmLabel: 'Delete'
					});
		if (!yes) {
			return;
		}
		sheet = undefined;
		const result = await api.remove(dir, [...names], folders.length > 0);
		if (!result.ok) {
			showToast(result.message, 'error');
			return;
		}
		const failed = result.data.failed[0];
		if (failed !== undefined) {
			showToast(failed.message, 'error');
		} else {
			showToast(`Deleted ${what}.`, 'success');
		}
		selected.clear();
		await load(view);
	}

	async function pickedFiles(input: HTMLInputElement): Promise<void> {
		const files = [...(input.files ?? [])];
		input.value = '';
		if (view.kind !== 'folder' || files.length === 0) {
			return;
		}
		const dir = view.path;
		const existing = new Set(
			listing.kind === 'ready' ? listing.value.entries.map((entry) => entry.name) : []
		);
		const clashes = files.filter((file) => existing.has(file.name));
		let replace = false;
		if (clashes.length > 0) {
			replace = await confirmAction({
				title:
					clashes.length === 1
						? `Replace “${clashes[0]?.name ?? ''}”?`
						: `Replace ${clashes.length} files?`,
				message: 'A file with the same name is already in this folder. Uploading replaces it.',
				confirmLabel: 'Replace'
			});
		}
		const chosen = files.filter((file) => replace || !existing.has(file.name));
		queue.add(
			chosen.map((file) => ({ file, replace: existing.has(file.name) })),
			dir
		);
	}

	async function saveName(name: string): Promise<string | undefined> {
		if (view.kind !== 'folder') {
			return undefined;
		}
		const dir = view.path;
		const current = naming;
		const result =
			current.kind === 'rename'
				? await api.rename(dir, current.entry.name, name)
				: await api.newFolder(dir, name);
		if (!result.ok) {
			return result.message;
		}
		naming = { kind: 'none' };
		showToast(current.kind === 'rename' ? `Renamed to ${name}.` : `Made ${name}.`, 'success');
		selected.clear();
		await load(view);
		return undefined;
	}
</script>

<div class="files">
	<BreadcrumbBar
		{crumbs}
		onpick={pickCrumb}
		onrefresh={() => {
			void load(view);
		}}
	/>

	{#if view.kind === 'roots'}
		{#if roots.kind === 'loading'}
			<LoadingVeil
				active={true}
				title="Reading the drives"
				detail={undefined}
				caption="shown"
				children={undefined}
			/>
		{:else if roots.kind === 'failed'}
			<EmptyState
				icon={IconAlertTriangle}
				title="Could not list the drives."
				detail={roots.message}
				children={undefined}
			/>
		{:else}
			<RootList roots={roots.value} onopen={openRoot} />
		{/if}
	{:else}
		<div class="toolbar">
			<div class="actions">
				<Button
					variant="primary"
					size="compact"
					type="button"
					onclick={() => {
						picker?.click();
					}}><IconFileUpload size={18} /> Upload</Button
				>
				<Button
					variant="secondary"
					size="compact"
					type="button"
					onclick={() => {
						naming = { kind: 'new-folder' };
					}}><IconFolderPlus size={18} /> New folder</Button
				>
			</div>
			<div class="options">
				<ChipGroup label="Sort by" options={sortOptions} bind:value={() => sort, setSort} />
				<Checkbox label="Show hidden" error={undefined} bind:checked={showHidden} />
			</div>
			<input
				data-raw-input="file-picker"
				class="picker"
				type="file"
				multiple
				aria-label="Files to upload"
				bind:this={picker}
				onchange={(event) => {
					void pickedFiles(event.currentTarget);
				}}
			/>
		</div>

		{#if listing.kind === 'loading'}
			<LoadingVeil
				active={true}
				title="Opening the folder"
				detail={undefined}
				caption="shown"
				children={undefined}
			/>
		{:else if listing.kind === 'failed'}
			<EmptyState
				icon={IconAlertTriangle}
				title="Could not open this folder."
				detail={listing.message}
			>
				<Button
					variant="secondary"
					size="compact"
					type="button"
					onclick={() => {
						void load(view);
					}}>Try again</Button
				>
			</EmptyState>
		{:else}
			{#if entries.length > 0}
				<Checkbox
					label="Select all"
					error={undefined}
					bind:checked={() => allSelected, selectAll}
				/>
			{/if}
			<EntryList
				{entries}
				more={listing.value.more}
				path={listing.value.path}
				{selected}
				ontoggle={toggle}
				onopen={openEntry}
			/>
		{/if}
	{/if}

	{#if selected.size > 0 || queue.items.length > 0}
		<div class="dock">
			{#if selected.size > 0}
				<SelectionBar
					count={selected.size}
					ondownload={() => {
						void downloadSelected();
					}}
					ondelete={() => {
						void remove([...selected]);
					}}
					onclear={() => {
						selected.clear();
					}}
				/>
			{/if}
			{#if queue.items.length > 0}
				<UploadTray {queue} />
			{/if}
		</div>
	{/if}
</div>

<EntrySheet
	entry={sheet}
	path={sheet === undefined ? '' : pathOf(sheet)}
	onopenfolder={openLinkedFolder}
	ondownload={download}
	onrename={renameFromSheet}
	ondelete={deleteFromSheet}
	onclose={() => {
		sheet = undefined;
	}}
/>

<NameDialog
	open={naming.kind !== 'none'}
	title={naming.kind === 'rename' ? `Rename ${naming.entry.name}` : 'New folder'}
	label={naming.kind === 'rename' ? 'New name' : 'Folder name'}
	initial={naming.kind === 'rename' ? naming.entry.name : ''}
	saveLabel={naming.kind === 'rename' ? 'Rename' : 'Make folder'}
	{flavour}
	onsave={saveName}
	onclose={() => {
		naming = { kind: 'none' };
	}}
/>

<style>
	.files {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: var(--space-3);
	}

	.toolbar {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-3);
	}

	.actions,
	.options {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-2) var(--space-3);
	}

	.picker {
		display: none;
	}

	.dock {
		position: sticky;
		bottom: calc(var(--tabbar-height) + var(--safe-bottom) + var(--space-2));
		z-index: 5;
		display: grid;
		max-height: 60vh;
		overflow-y: auto;
		gap: var(--space-2);
	}

	@media (min-width: 900px) {
		.dock {
			bottom: calc(var(--space-4) + var(--safe-bottom));
		}
	}
</style>

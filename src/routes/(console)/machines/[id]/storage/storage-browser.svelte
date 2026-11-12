<script lang="ts">
	import { onMount } from 'svelte';
	import { resolve } from '$app/paths';
	import {
		IconAlertTriangle,
		IconExternalLink,
		IconRefresh,
		IconScan
	} from '@tabler/icons-svelte-runes';
	import type { Crumb } from '#lib/domain/files/files.ts';
	import type { Machine } from '#lib/domain/machines/machine.ts';
	import {
		lowDiskDrives,
		scanLine,
		storageCrumbs,
		type DriveSummary,
		type FolderChild,
		type FolderView,
		type LargeFile,
		type StorageSummary
	} from '#lib/domain/storage/storage.ts';
	import Button from '#lib/ui/button.svelte';
	import ChipGroup from '#lib/ui/chip-group.svelte';
	import EmptyState from '#lib/ui/empty-state.svelte';
	import LoadingVeil from '#lib/ui/loading-veil.svelte';
	import Notice from '#lib/ui/notice.svelte';
	import Panel from '#lib/ui/panel.svelte';
	import RadarSpinner from '#lib/ui/radar-spinner.svelte';
	import { showToast } from '#lib/ui/toast.svelte.ts';
	import { formatBytes, formatRelative } from '#lib/utils/format.ts';
	import BreadcrumbBar from '../files/breadcrumb-bar.svelte';
	import DriveList from './drive-list.svelte';
	import FolderList from './folder-list.svelte';
	import LargestList from './largest-list.svelte';
	import { storageApi } from './storage-api.ts';
	import CleanupPanel from './cleanup-panel.svelte';
	import LowDiskNotice from '../low-disk-notice.svelte';

	/**
	 * Where the machine's disk space went (SPEC-STORAGE 7), from the agent's
	 * slow background scan: drives, then the biggest folders level by level,
	 * or the largest files. Everything here is the last complete scan, read
	 * live from the machine; the server checks `files` on every request.
	 */
	let { machine }: { machine: Machine } = $props();

	type View = { kind: 'roots' } | { kind: 'folder'; mount: string; path: string };
	type Loaded<T> =
		{ kind: 'loading' } | { kind: 'ready'; value: T } | { kind: 'failed'; message: string };
	type Folder = { view: FolderView; children: FolderChild[] };
	type Mode = 'folders' | 'files';

	/** While a scan runs, the drives are read again this often. */
	const REFRESH_MS = 30_000;
	/** After Rescan now, the drives are read this often until the scan shows (S27). */
	const PENDING_MS = 2000;
	/** After this, the tab stops waiting and says the machine will scan when it can. */
	const PENDING_LIMIT_MS = 60_000;

	/** Rescan now, from the click to the scan showing (SPEC-STORAGE S27). */
	type Rescan =
		| { kind: 'idle' }
		| { kind: 'asking' }
		| { kind: 'waiting'; sinceMs: number }
		| { kind: 'already' }
		| { kind: 'late' };

	const api = $derived(storageApi(machine.id));
	const filesKey = $derived(`bmuster.files.${machine.id}`);

	let view = $state<View>({ kind: 'roots' });
	let summary = $state<Loaded<StorageSummary>>({ kind: 'loading' });
	let folder = $state<Loaded<Folder>>({ kind: 'loading' });
	let largest = $state<Loaded<LargeFile[]>>({ kind: 'loading' });
	let mode = $state<Mode>('folders');
	let rescanState = $state<Rescan>({ kind: 'idle' });
	let now = $state(Date.now());
	let loads = 0;

	const crumbs = $derived(
		view.kind === 'folder'
			? storageCrumbs(view.mount, view.path)
			: [{ label: 'Drives', target: { kind: 'roots' } } satisfies Crumb]
	);
	const drives = $derived(summary.kind === 'ready' ? summary.value.drives : []);
	const openDrive = $derived.by(() => {
		const current = view;
		return current.kind === 'folder'
			? drives.find((drive) => drive.mount === current.mount)
			: undefined;
	});
	const scanning = $derived(drives.some((drive) => drive.scanning.kind === 'running'));
	const scanPercent = $derived(
		drives.reduce(
			(found, drive) => (drive.scanning.kind === 'running' ? drive.scanning.percent : found),
			0
		)
	);
	const nearlyFull = $derived(lowDiskDrives(drives));
	const pending = $derived(rescanState.kind === 'asking' || rescanState.kind === 'waiting');
	const rescanHint = $derived.by(() => {
		switch (rescanState.kind) {
			case 'already':
				return `Already scanning, ${scanPercent} %.`;
			case 'late':
				return 'The machine has not started the scan yet; it will when it can.';
			case 'idle':
			case 'asking':
			case 'waiting':
				return 'Scans run slowly in the background, about once a day.';
		}
	});
	const modeOptions = [
		{ value: 'folders' as const, label: 'Folders', count: undefined },
		{ value: 'files' as const, label: 'Largest files', count: undefined }
	];
	const exactTime = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

	onMount(() => {
		void loadSummary(true);
		const timer = setInterval(() => {
			if (scanning) {
				void loadSummary(false);
			}
		}, REFRESH_MS);
		const pendingTimer = setInterval(() => {
			void followRescan();
		}, PENDING_MS);
		return () => {
			clearInterval(timer);
			clearInterval(pendingTimer);
		};
	});

	async function loadSummary(showLoading: boolean): Promise<void> {
		if (showLoading) {
			summary = { kind: 'loading' };
		}
		const result = await api.summary();
		now = Date.now();
		summary = result.ok
			? { kind: 'ready', value: result.data }
			: { kind: 'failed', message: result.message };
	}

	async function loadFolder(target: { mount: string; path: string }): Promise<void> {
		loads += 1;
		const mine = loads;
		folder = { kind: 'loading' };
		largest = { kind: 'loading' };
		const [listed, files] = await Promise.all([
			api.folder(target.mount, target.path, 0),
			api.largest(target.mount, target.path)
		]);
		if (mine !== loads) {
			return;
		}
		folder = listed.ok
			? { kind: 'ready', value: { view: listed.data, children: listed.data.children } }
			: { kind: 'failed', message: listed.message };
		largest = files.ok
			? { kind: 'ready', value: files.data.files }
			: { kind: 'failed', message: files.message };
	}

	function open(target: View): void {
		view = target;
		if (target.kind === 'folder' && hasScan(target.mount)) {
			void loadFolder(target);
		}
	}

	function hasScan(mount: string): boolean {
		return drives.some((drive) => drive.mount === mount && drive.lastScan.kind === 'complete');
	}

	function pickCrumb(target: Crumb['target']): void {
		if (target.kind === 'roots' || view.kind === 'roots') {
			open({ kind: 'roots' });
			return;
		}
		open({ kind: 'folder', mount: view.mount, path: target.path });
	}

	function refresh(): void {
		if (view.kind === 'folder') {
			open(view);
		}
		void loadSummary(false);
	}

	async function more(): Promise<void> {
		if (folder.kind !== 'ready') {
			return;
		}
		const shown = folder.value;
		const next = await api.folder(shown.view.mount, shown.view.path, shown.children.length);
		if (!next.ok) {
			showToast(next.message, 'error');
			return;
		}
		folder = {
			kind: 'ready',
			value: { view: next.data, children: [...shown.children, ...next.data.children] }
		};
	}

	async function rescan(): Promise<void> {
		rescanState = { kind: 'asking' };
		const result = await api.rescan();
		if (!result.ok) {
			rescanState = { kind: 'idle' };
			showToast(result.message, 'error');
			return;
		}
		rescanState = result.data.alreadyScanning
			? { kind: 'already' }
			: { kind: 'waiting', sinceMs: Date.now() };
		await loadSummary(false);
	}

	/** Whether the asked-for scan shows: a pass running, or a scan finished since the click. */
	function scanShows(sinceMs: number): boolean {
		return drives.some(
			(drive) =>
				drive.scanning.kind === 'running' ||
				(drive.lastScan.kind === 'complete' && drive.lastScan.finishedAtMs >= sinceMs)
		);
	}

	/** Every 2 s after Rescan now: back to normal once the scan shows, or say it is late. */
	async function followRescan(): Promise<void> {
		const current = rescanState;
		if (current.kind === 'already' && !scanning) {
			rescanState = { kind: 'idle' };
		}
		if (current.kind !== 'waiting') {
			return;
		}
		await loadSummary(false);
		if (rescanState !== current) {
			return;
		}
		if (scanShows(current.sinceMs)) {
			rescanState = { kind: 'idle' };
		} else if (Date.now() - current.sinceMs >= PENDING_LIMIT_MS) {
			rescanState = { kind: 'late' };
		}
	}

	function setMode(value: Mode | null): void {
		if (value !== null) {
			mode = value;
		}
	}

	function openInFiles(path: string): void {
		try {
			sessionStorage.setItem(filesKey, path);
		} catch {
			// No storage (a private window): Files opens at the top.
		}
	}

	function finishedText(finishedAtMs: number): string {
		return `From the scan finished ${formatRelative(new Date(finishedAtMs).toISOString(), now)}`;
	}
</script>

{#snippet notScanned(drive: DriveSummary)}
	<EmptyState
		icon={IconScan}
		title={drive.scanning.kind === 'running' ? scanLine(drive, now) : 'Not scanned yet.'}
		detail="The scan builds slowly in the background, so it never slows the machine down. The first one starts about 10 minutes after the agent starts."
		children={undefined}
	/>
{/snippet}

{#snippet folderHeader(shown: FolderView)}
	<Panel heading={undefined} actions={undefined} tone="normal" padding="normal">
		<div class="summary">
			<div class="facts">
				<span class="total">{formatBytes(shown.bytes)}</span>
				<span class="files">in {new Intl.NumberFormat().format(shown.files)} files</span>
			</div>
			<a
				class="open-files"
				href={resolve('/(console)/machines/[id]/files', { id: machine.id })}
				onclick={() => {
					openInFiles(shown.path);
				}}><IconExternalLink size={16} /> Open in Files</a
			>
		</div>
		<p class="fresh" title={exactTime.format(shown.finishedAtMs)}>
			{finishedText(shown.finishedAtMs)}
		</p>
	</Panel>
{/snippet}

<div class="storage">
	<BreadcrumbBar {crumbs} onpick={pickCrumb} onrefresh={refresh} />

	{#if summary.kind === 'loading'}
		<LoadingVeil active={true} title="Reading the drives" detail={undefined} children={undefined} />
	{:else if summary.kind === 'failed'}
		<EmptyState
			icon={IconAlertTriangle}
			title="Could not read the storage scan."
			detail={summary.message}
		>
			<Button
				variant="secondary"
				size="compact"
				type="button"
				onclick={() => {
					void loadSummary(true);
				}}><IconRefresh size={18} /> Try again</Button
			>
		</EmptyState>
	{:else if view.kind === 'roots'}
		{#if summary.value.problem.kind === 'failed'}
			<Notice tone="warning" title="The last scan could not be saved.">
				<p>{summary.value.problem.message}</p>
			</Notice>
		{/if}
		<div class="toolbar">
			{#if pending}
				<p class="hint pending" role="status">
					<RadarSpinner size="small" /> Asking {machine.name} to scan…
				</p>
			{:else}
				<p class="hint" role="status">{rescanHint}</p>
			{/if}
			{#if !pending}
				<Button
					variant="secondary"
					size="compact"
					type="button"
					onclick={() => {
						void rescan();
					}}
				>
					<IconRefresh size={18} />
					Rescan now
				</Button>
			{/if}
		</div>
		<LowDiskNotice drives={nearlyFull} storageOf={undefined} />
		<DriveList
			drives={summary.value.drives}
			{now}
			onopen={(mount: string) => {
				open({ kind: 'folder', mount, path: mount });
			}}
		/>
		<CleanupPanel {api} />
	{:else if openDrive?.lastScan.kind === 'none'}
		{@render notScanned(openDrive)}
	{:else if folder.kind === 'loading'}
		<LoadingVeil active={true} title="Opening the scan" detail={undefined} children={undefined} />
	{:else if folder.kind === 'failed'}
		<EmptyState
			icon={IconAlertTriangle}
			title="Could not open this folder."
			detail={folder.message}
		>
			<Button
				variant="secondary"
				size="compact"
				type="button"
				onclick={() => {
					open({ kind: 'roots' });
				}}>Back to the drives</Button
			>
		</EmptyState>
	{:else}
		{@render folderHeader(folder.value.view)}
		<ChipGroup label="Show" options={modeOptions} bind:value={() => mode, setMode} />
		{#if mode === 'folders'}
			<FolderList
				view={folder.value.view}
				children={folder.value.children}
				onopen={(path: string) => {
					if (view.kind === 'folder') {
						open({ kind: 'folder', mount: view.mount, path });
					}
				}}
				onmore={() => {
					void more();
				}}
			/>
		{:else if largest.kind === 'ready'}
			<LargestList files={largest.value} path={folder.value.view.path} />
		{:else if largest.kind === 'failed'}
			<EmptyState
				icon={IconAlertTriangle}
				title="Could not list the largest files."
				detail={largest.message}
				children={undefined}
			/>
		{:else}
			<LoadingVeil
				active={true}
				title="Finding the largest files"
				detail={undefined}
				children={undefined}
			/>
		{/if}
	{/if}
</div>

<style>
	/* minmax(0, 1fr): a long folder name scrolls in the path bar, never widens the page. */
	.storage {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: var(--space-4);
		min-width: 0;
	}

	.toolbar {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-3);
	}

	.hint {
		display: inline-flex;
		align-items: center;
		gap: var(--space-2);
		margin: 0;
		color: var(--muted);
		font-size: var(--text-sm);
	}

	.summary {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		justify-content: space-between;
		gap: var(--space-3);
	}

	.facts {
		display: flex;
		align-items: baseline;
		gap: var(--space-2);
	}

	.total {
		font-size: var(--text-xl);
		font-weight: var(--weight-semibold);
	}

	.files,
	.fresh {
		color: var(--muted);
		font-size: var(--text-sm);
	}

	.fresh {
		margin: 0;
	}

	.open-files {
		display: inline-flex;
		align-items: center;
		gap: var(--space-1);
		min-height: 40px;
		color: var(--brand);
		font-size: var(--text-sm);
		text-decoration: none;
	}

	.open-files:hover {
		text-decoration: underline;
	}
</style>

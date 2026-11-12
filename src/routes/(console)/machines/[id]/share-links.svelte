<script lang="ts">
	import { onMount } from 'svelte';
	import { resolve } from '$app/paths';
	import { IconLink } from '@tabler/icons-svelte-runes';
	import {
		lastUseLabel,
		SHARE_DURATIONS,
		shareDurationShortLabel,
		sharePermissionsLabel,
		timeLeftLabel,
		type ShareDuration,
		type ShareLinkView
	} from '#lib/domain/share-links/share-links.ts';
	import {
		createShareLinkReplySchema,
		createShareLinkRequestSchema,
		endShareLinkReplySchema,
		machineShareLinksReplySchema
	} from '#lib/schemas/share-links/share-links.ts';
	import Button from '#lib/ui/button.svelte';
	import Checkbox from '#lib/ui/checkbox.svelte';
	import { confirmAction } from '#lib/ui/confirm-action.svelte.ts';
	import CopyField from '#lib/ui/copy-field.svelte';
	import ListCard from '#lib/ui/list-card.svelte';
	import ListRow from '#lib/ui/list-row.svelte';
	import Modal from '#lib/ui/modal.svelte';
	import SegmentedControl from '#lib/ui/segmented-control.svelte';
	import TextField from '#lib/ui/text-field.svelte';
	import { showToast } from '#lib/ui/toast.svelte.ts';
	import { apiRequest } from '#lib/utils/api-client.ts';
	import { formatRelative } from '#lib/utils/format.ts';

	/**
	 * Share links on a machine's page (SPEC-SHARE-LINKS SL17): the active
	 * links with time left and End now, and Share, which makes a new one and
	 * shows its address once. Shown only to people with `share-links` here;
	 * the server checks again on every request.
	 */
	let { machineId, machineName }: { machineId: string; machineName: string } = $props();

	let links = $state<ShareLinkView[]>([]);
	let canControl = $state(false);
	let now = $state(Date.now());

	/** The modal: closed, the form, or the new link's address (shown this once). */
	let dialog = $state<{ kind: 'closed' } | { kind: 'form' } | { kind: 'made'; url: string }>({
		kind: 'closed'
	});
	let recipient = $state('');
	let duration = $state<ShareDuration | null>('1h');
	let control = $state(false);
	let problem = $state<string | undefined>(undefined);
	let busy = $state(false);

	const listUrl = $derived(resolve('/api/machines/[id]/share-links', { id: machineId }));
	const durations = SHARE_DURATIONS.map((value) => ({
		value,
		label: shareDurationShortLabel(value)
	}));

	async function load(): Promise<void> {
		const result = await apiRequest({
			method: 'GET',
			url: listUrl,
			body: undefined,
			reply: machineShareLinksReplySchema
		});
		if (!result.ok) {
			showToast(result.message, 'error');
			return;
		}
		links = result.data.links;
		canControl = result.data.canTick.control;
	}

	onMount(() => {
		void load();
		const clock = setInterval(() => {
			now = Date.now();
			if (links.some((link) => Date.parse(link.expiresIso) <= now)) {
				links = links.filter((link) => Date.parse(link.expiresIso) > now);
			}
		}, 1000);
		return () => {
			clearInterval(clock);
		};
	});

	function openForm(): void {
		recipient = '';
		duration = '1h';
		control = false;
		problem = undefined;
		dialog = { kind: 'form' };
	}

	async function create(): Promise<void> {
		if (busy) {
			return;
		}
		const checked = createShareLinkRequestSchema.safeParse({
			recipient,
			duration,
			control: control && canControl,
			files: false
		});
		if (!checked.success) {
			problem = checked.error.issues[0]?.message;
			return;
		}
		busy = true;
		const result = await apiRequest({
			method: 'POST',
			url: listUrl,
			body: checked.data,
			reply: createShareLinkReplySchema
		});
		busy = false;
		if (!result.ok) {
			problem = result.message;
			return;
		}
		links = [...links, result.data.link].sort(
			(a, b) => Date.parse(a.expiresIso) - Date.parse(b.expiresIso)
		);
		dialog = { kind: 'made', url: result.data.url };
	}

	async function endNow(link: ShareLinkView): Promise<void> {
		const yes = await confirmAction({
			title: `End the link for ${link.recipient}?`,
			message: 'The link stops working at once, and anyone connected with it is disconnected.',
			confirmLabel: 'End now'
		});
		if (!yes) {
			return;
		}
		const result = await apiRequest({
			method: 'DELETE',
			url: resolve('/api/share-links/[id=uuid]', { id: link.id }),
			body: undefined,
			reply: endShareLinkReplySchema
		});
		if (!result.ok) {
			showToast(result.message, 'error');
			await load();
			return;
		}
		links = links.filter((each) => each.id !== link.id);
		showToast(`The link for ${link.recipient} has ended.`, 'success');
	}

	function closeDialog(): void {
		dialog = { kind: 'closed' };
	}
</script>

{#snippet shareAction()}
	<Button variant="secondary" size="compact" type="button" onclick={openForm}>
		<IconLink size={18} /> Share
	</Button>
{/snippet}

{#snippet linkRow(link: ShareLinkView)}
	<ListRow action={{ kind: 'static' }} align="center" dimmed={false}>
		<div class="link">
			<p class="who">{link.recipient}</p>
			<p class="what">
				{sharePermissionsLabel(link.permissions)} · by {link.createdByName} · {timeLeftLabel(
					Date.parse(link.expiresIso),
					now
				)} left
			</p>
			<p class="what">{lastUseLabel(link.lastUse, (iso) => formatRelative(iso, now))}</p>
		</div>
		<Button variant="secondary" size="compact" type="button" onclick={() => void endNow(link)}
			>End now</Button
		>
	</ListRow>
{/snippet}

<ListCard
	heading="Share links"
	actions={shareAction}
	label="Active share links for {machineName}"
	items={links}
	key={(link: ShareLinkView) => link.id}
	row={linkRow}
	empty="No active links. Share gives someone without an account this machine's screen for a while."
/>

<Modal
	open={dialog.kind !== 'closed'}
	title={dialog.kind === 'made' ? 'Link ready' : `Share ${machineName}`}
	onclose={closeDialog}
>
	{#if dialog.kind === 'made'}
		<div class="fields">
			<p class="hint">
				Send this to them now. It is shown only once; if it is lost, end it and make another.
			</p>
			<CopyField value={dialog.url} label="share link" />
		</div>
	{:else}
		<div class="fields">
			<p class="hint">
				Anyone with the link can open this machine's screen until it ends. It is kept in Activity.
			</p>
			<p class="hint">
				The guest connects without asking the person at the machine first. They will see that
				someone is connected and can disconnect them.
			</p>
			<TextField
				label="Who it is for"
				name="recipient"
				type="text"
				autocomplete="off"
				autocapitalize="words"
				required={true}
				error={problem}
				bind:value={recipient}
			/>
			<SegmentedControl label="How long" options={durations} bind:value={duration} />
			<div class="allows">
				<span class="label">What it allows</span>
				<p class="always">Watch desktop (always)</p>
				{#if canControl}
					<Checkbox label="Control desktop" error={undefined} bind:checked={control} />
				{/if}
			</div>
		</div>
	{/if}
	{#snippet footer()}
		{#if dialog.kind === 'made'}
			<Button variant="primary" size="compact" type="button" onclick={closeDialog}>Done</Button>
		{:else}
			<Button variant="secondary" size="compact" type="button" onclick={closeDialog}>Cancel</Button>
			<Button variant="primary" size="compact" type="button" onclick={() => void create()}
				>Create link</Button
			>
		{/if}
	{/snippet}
</Modal>

<style>
	.link {
		flex: 1;
		min-width: 0;
	}

	.who {
		font-weight: var(--weight-semibold);
		overflow-wrap: anywhere;
	}

	.what {
		color: var(--muted);
		font-size: var(--text-sm);
	}

	.fields {
		display: grid;
		gap: var(--space-4);
	}

	.hint {
		margin: 0;
		color: var(--muted);
		font-size: var(--text-sm);
	}

	.allows {
		display: grid;
		gap: var(--space-1);
	}

	.label {
		color: var(--text-soft);
		font-size: var(--text-sm);
		font-weight: var(--weight-medium);
	}

	.always {
		margin: 0;
		color: var(--text);
		font-size: var(--text-sm);
	}
</style>

<script lang="ts">
	import { refreshAll } from '$app/navigation';
	import { IconEdit, IconPlus, IconTrash } from '@tabler/icons-svelte-runes';
	import {
		deleteNoteReplySchema,
		noteBodySchema,
		noteReplySchema,
		type NoteView
	} from '#lib/schemas/machines/machine-notes.ts';
	import Button from '#lib/ui/button.svelte';
	import Modal from '#lib/ui/modal.svelte';
	import TextField from '#lib/ui/text-field.svelte';
	import { confirmAction } from '#lib/ui/confirm-action.svelte.ts';
	import { showToast } from '#lib/ui/toast.svelte.ts';
	import { apiRequest } from '#lib/utils/api-client.ts';
	import { formatRelative } from '#lib/utils/format.ts';
	import type { PageProps } from './$types';

	/**
	 * Notes on a machine (SPEC-MACHINE-DETAILS D3, D4): plain text, newest
	 * first. Anyone who can see the machine adds one; the author edits theirs;
	 * the author or an admin deletes (with confirmation).
	 */
	let { data }: PageProps = $props();

	const notesUrl = $derived(`/api/machines/${data.machine.id}/notes`);

	let draft = $state('');
	let draftError = $state<string | undefined>(undefined);
	let adding = $state(false);

	type Editing = { kind: 'closed' } | { kind: 'open'; note: NoteView };
	let editing = $state<Editing>({ kind: 'closed' });
	let editText = $state('');
	let editError = $state<string | undefined>(undefined);

	async function addNote(): Promise<void> {
		const checked = noteBodySchema.safeParse(draft);
		if (!checked.success) {
			draftError = checked.error.issues[0]?.message;
			return;
		}
		adding = true;
		const result = await apiRequest({
			method: 'POST',
			url: notesUrl,
			body: { body: checked.data },
			reply: noteReplySchema
		});
		adding = false;
		if (!result.ok) {
			draftError = result.message;
			return;
		}
		draft = '';
		draftError = undefined;
		showToast('Note added.', 'success');
		await refreshAll();
	}

	function openEdit(note: NoteView): void {
		editText = note.body;
		editError = undefined;
		editing = { kind: 'open', note };
	}

	function closeEdit(): void {
		editing = { kind: 'closed' };
	}

	async function saveEdit(note: NoteView): Promise<void> {
		const checked = noteBodySchema.safeParse(editText);
		if (!checked.success) {
			editError = checked.error.issues[0]?.message;
			return;
		}
		const result = await apiRequest({
			method: 'PATCH',
			url: `${notesUrl}/${note.id}`,
			body: { body: checked.data },
			reply: noteReplySchema
		});
		if (!result.ok) {
			editError = result.message;
			return;
		}
		closeEdit();
		showToast('Note saved.', 'success');
		await refreshAll();
	}

	async function deleteNote(note: NoteView): Promise<void> {
		const yes = await confirmAction({
			title: 'Delete this note?',
			message: `The note by ${note.authorName} disappears from this machine. The deletion is recorded in Activity.`,
			confirmLabel: 'Delete note'
		});
		if (!yes) {
			return;
		}
		const result = await apiRequest({
			method: 'DELETE',
			url: `${notesUrl}/${note.id}`,
			body: undefined,
			reply: deleteNoteReplySchema
		});
		showToast(result.ok ? 'Note deleted.' : result.message, result.ok ? 'success' : 'error');
		await refreshAll();
	}

	function when(iso: string): string {
		return new Date(iso).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
	}
</script>

<div class="sections">
	<section class="panel">
		<h2>Add a note</h2>
		<form
			class="add"
			onsubmit={(event) => {
				event.preventDefault();
				void addNote();
			}}
		>
			<TextField
				label="Note"
				name="note"
				type="multiline"
				autocomplete="off"
				autocapitalize="sentences"
				required={false}
				error={draftError}
				bind:value={draft}
			/>
			<div class="add-actions">
				<Button variant="primary" size="compact" type="submit" onclick={undefined}>
					<IconPlus size={18} />
					{adding ? 'Adding…' : 'Add note'}
				</Button>
			</div>
		</form>
	</section>

	{#if data.notes.length === 0}
		<p class="empty">No notes yet. Write down what this machine is for or what was done to it.</p>
	{:else}
		<ul class="notes" aria-label="Notes, newest first">
			{#each data.notes as note (note.id)}
				<li class="note">
					<div class="note-head">
						<p class="meta">
							<strong>{note.authorName}</strong>
							<time datetime={note.createdIso} title={when(note.createdIso)}>
								{formatRelative(note.createdIso, data.now)}
							</time>
							{#if note.edited.kind === 'yes'}
								<span class="edited" title="Edited {when(note.edited.editedIso)}">edited</span>
							{/if}
						</p>
						<div class="note-actions">
							{#if note.canEdit}
								<button
									data-raw-button="icon"
									type="button"
									class="icon"
									aria-label="Edit note"
									onclick={() => {
										openEdit(note);
									}}
								>
									<IconEdit size={18} />
								</button>
							{/if}
							{#if note.canDelete}
								<button
									data-raw-button="icon"
									type="button"
									class="icon danger"
									aria-label="Delete note"
									onclick={() => {
										void deleteNote(note);
									}}
								>
									<IconTrash size={18} />
								</button>
							{/if}
						</div>
					</div>
					<p class="body">{note.body}</p>
				</li>
			{/each}
		</ul>
	{/if}
</div>

<Modal open={editing.kind === 'open'} title="Edit note" onclose={closeEdit}>
	<TextField
		label="Note"
		name="note-edit"
		type="multiline"
		autocomplete="off"
		autocapitalize="sentences"
		required={false}
		error={editError}
		bind:value={editText}
	/>
	{#snippet footer()}
		<Button variant="secondary" size="compact" type="button" onclick={closeEdit}>Cancel</Button>
		<Button
			variant="primary"
			size="compact"
			type="button"
			onclick={() => {
				if (editing.kind === 'open') {
					void saveEdit(editing.note);
				}
			}}>Save</Button
		>
	{/snippet}
</Modal>

<style>
	.sections {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: var(--space-4);
	}

	.panel {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: var(--space-3);
		padding: var(--space-4);
		border: 1px solid var(--border);
		border-radius: var(--radius-card);
		background: var(--surface-elevated);
		box-shadow: var(--shadow-card);
	}

	h2 {
		font-size: var(--text-sm);
		font-weight: var(--weight-semibold);
		color: var(--muted);
		text-transform: uppercase;
		letter-spacing: var(--tracking-caps);
	}

	.add {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: var(--space-3);
	}

	.add-actions {
		display: flex;
		justify-content: flex-end;
	}

	.empty {
		padding: var(--space-8) 0;
		color: var(--muted);
		font-size: var(--text-sm);
		text-align: center;
	}

	.notes {
		display: grid;
		gap: var(--space-3);
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.note {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: var(--space-2);
		padding: var(--space-4);
		border: 1px solid var(--border);
		border-radius: var(--radius-card);
		background: var(--surface-elevated);
		box-shadow: var(--shadow-card);
	}

	.note-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-2);
	}

	.meta {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		gap: var(--space-1) var(--space-2);
		min-width: 0;
		color: var(--muted);
		font-size: var(--text-xs);
	}

	.meta strong {
		color: var(--text);
		font-size: var(--text-sm);
		font-weight: var(--weight-semibold);
	}

	.edited {
		font-style: italic;
	}

	.note-actions {
		display: flex;
		gap: var(--space-1);
		flex-shrink: 0;
	}

	.icon {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 40px;
		height: 40px;
		border: none;
		border-radius: var(--radius-pill);
		background: transparent;
		color: var(--text-soft);
		cursor: pointer;
	}

	.icon:hover {
		background: var(--surface-muted);
	}

	.icon.danger:hover {
		color: var(--danger);
	}

	/* Plain text: line breaks kept, long words wrapped. Never rendered as HTML. */
	.body {
		font-size: var(--text-sm);
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}
</style>

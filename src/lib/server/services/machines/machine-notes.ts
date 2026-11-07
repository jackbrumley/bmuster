import { and, desc, eq, isNull } from 'drizzle-orm';
import type { ConsoleUser } from '#lib/domain/users/user.ts';
import type { NoteView } from '#lib/schemas/machines/machine-notes.ts';
import { machineNotes, machines } from '../../database/schema.ts';
import type { AppDatabase, Queryable } from '../../database/connection.ts';
import { recordAudit } from '../audit/audit.ts';
import { userNames } from '../users/users.ts';

/**
 * Notes on a machine (SPEC-MACHINE-DETAILS D3–D5). Callers check that the
 * person can see the machine (access service); this file decides who may
 * change a note: the author edits; the author or an admin deletes. Deleting
 * keeps the row (deleted_at) and is audited.
 */

type NoteRow = typeof machineNotes.$inferSelect;

export type NoteChange<T> =
	{ kind: 'done'; value: T } | { kind: 'not-found' } | { kind: 'not-allowed' };

/** Notes not deleted, newest first. */
export function listNotes(database: Queryable, machineId: string, viewer: ConsoleUser): NoteView[] {
	const notes = database
		.select()
		.from(machineNotes)
		.where(and(eq(machineNotes.machineId, machineId), isNull(machineNotes.deletedAt)))
		.orderBy(desc(machineNotes.createdAt))
		.all();
	const names = userNames(database, [...new Set(notes.map((note) => note.authorUserId))]);
	return notes.map((note) => toView(note, authorName(names, note), viewer));
}

/** Undefined when the machine is unknown or removed. */
export function addNote(
	database: AppDatabase,
	machineId: string,
	author: ConsoleUser,
	body: string,
	now: number
): NoteView | undefined {
	const machine = database
		.select({ removedAt: machines.removedAt })
		.from(machines)
		.where(eq(machines.id, machineId))
		.get();
	if (machine?.removedAt !== null) {
		return undefined;
	}
	const row: NoteRow = {
		id: crypto.randomUUID(),
		machineId,
		authorUserId: author.id,
		body,
		createdAt: new Date(now),
		editedAt: null,
		deletedAt: null
	};
	database.insert(machineNotes).values(row).run();
	return toView(row, author.name, author);
}

/** Only the author edits a note. */
export function editNote(
	database: AppDatabase,
	machineId: string,
	noteId: string,
	editor: ConsoleUser,
	body: string,
	now: number
): NoteChange<NoteView> {
	return database.transaction((tx) => {
		const found = findNote(tx, machineId, noteId);
		if (found === undefined) {
			return { kind: 'not-found' };
		}
		if (found.note.authorUserId !== editor.id) {
			return { kind: 'not-allowed' };
		}
		const editedAt = new Date(now);
		tx.update(machineNotes).set({ body, editedAt }).where(eq(machineNotes.id, noteId)).run();
		return {
			kind: 'done',
			value: toView({ ...found.note, body, editedAt }, found.authorName, editor)
		};
	});
}

/** The author or an admin deletes a note; audited with the machine and the note's author. */
export function deleteNote(
	database: AppDatabase,
	machineId: string,
	noteId: string,
	deleter: ConsoleUser,
	now: number
): NoteChange<null> {
	return database.transaction((tx) => {
		const found = findNote(tx, machineId, noteId);
		if (found === undefined) {
			return { kind: 'not-found' };
		}
		if (!mayDelete(found.note, deleter)) {
			return { kind: 'not-allowed' };
		}
		tx.update(machineNotes)
			.set({ deletedAt: new Date(now) })
			.where(eq(machineNotes.id, noteId))
			.run();
		recordAudit(
			tx,
			{
				actor: { kind: 'user', userId: deleter.id },
				kind: 'machine-note-deleted',
				target: found.machineName,
				machineId,
				detail: { author: found.authorName, note: preview(found.note.body) }
			},
			now
		);
		return { kind: 'done', value: null };
	});
}

function findNote(
	database: Queryable,
	machineId: string,
	noteId: string
): { note: NoteRow; authorName: string; machineName: string } | undefined {
	const row = database
		.select({ note: machineNotes, machineName: machines.name })
		.from(machineNotes)
		.innerJoin(machines, eq(machines.id, machineNotes.machineId))
		.where(
			and(
				eq(machineNotes.id, noteId),
				eq(machineNotes.machineId, machineId),
				isNull(machineNotes.deletedAt),
				isNull(machines.removedAt)
			)
		)
		.get();
	if (row === undefined) {
		return undefined;
	}
	const names = userNames(database, [row.note.authorUserId]);
	return { ...row, authorName: authorName(names, row.note) };
}

/** Users are disabled, never deleted, so an author's name is always there. */
function authorName(names: Map<string, string>, note: NoteRow): string {
	const name = names.get(note.authorUserId);
	if (name === undefined) {
		throw new Error(`Note ${note.id} has an author who is not a user`);
	}
	return name;
}

function mayDelete(note: NoteRow, person: ConsoleUser): boolean {
	return note.authorUserId === person.id || person.role === 'admin';
}

/** The start of a deleted note for the audit log, so the log says which one went. */
function preview(body: string): string {
	const line = body.replace(/\s+/g, ' ').trim();
	return line.length > 80 ? `${line.slice(0, 79)}…` : line;
}

function toView(note: NoteRow, authorName: string, viewer: ConsoleUser): NoteView {
	return {
		id: note.id,
		authorName,
		body: note.body,
		createdIso: note.createdAt.toISOString(),
		edited:
			note.editedAt === null
				? { kind: 'no' }
				: { kind: 'yes', editedIso: note.editedAt.toISOString() },
		canEdit: note.authorUserId === viewer.id,
		canDelete: mayDelete(note, viewer)
	};
}

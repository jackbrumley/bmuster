import { describe, expect, it } from 'vitest';
import { toConsoleUser } from '#lib/server/services/users/users.ts';
import { noteBodySchema } from '#lib/schemas/machines/machine-notes.ts';
import { grantAccess } from '#tests/helpers/access.ts';
import { enrolFakeAgent, testDatabase } from '#tests/helpers/fake-agent.ts';
import { addTestUser, NOW } from '#tests/helpers/people.ts';
import type { AppDatabase } from '../../database/connection.ts';
import { canSeeMachine } from '../access/access.ts';
import { addNote, deleteNote, editNote, listNotes } from './machine-notes.ts';
import { removeMachine } from './machine-views.ts';

async function setUp(database: AppDatabase) {
	const machine = enrolFakeAgent(database, NOW);
	const ada = toConsoleUser(
		await addTestUser(database, { email: 'ada@example.com', role: 'admin', password: null })
	);
	const ben = toConsoleUser(
		await addTestUser(database, { email: 'ben@example.com', role: 'admin', password: null })
	);
	const mo = toConsoleUser(
		await addTestUser(database, { email: 'mo@example.com', role: 'member', password: null })
	);
	return { machineId: machine.machineId, ada, ben, mo };
}

describe('notes (D3)', () => {
	it('lists notes newest first with author, time and text, line breaks kept', async () => {
		const database = testDatabase();
		const { machineId, ada, ben } = await setUp(database);
		addNote(database, machineId, ada, 'New SSD fitted.\nOld one in the drawer.', NOW + 1);
		addNote(database, machineId, ben, 'Do not reboot during business hours.', NOW + 2);
		expect(listNotes(database, machineId, ada)).toMatchObject([
			{
				authorName: 'ben',
				body: 'Do not reboot during business hours.',
				createdIso: new Date(NOW + 2).toISOString(),
				edited: { kind: 'no' }
			},
			{
				authorName: 'ada',
				body: 'New SSD fitted.\nOld one in the drawer.',
				createdIso: new Date(NOW + 1).toISOString()
			}
		]);
	});

	it('takes plain text of 1 to 10 000 characters', () => {
		expect(noteBodySchema.safeParse('').success).toBe(false);
		expect(noteBodySchema.safeParse(' \n ').success).toBe(false);
		expect(noteBodySchema.safeParse('x'.repeat(10_000)).success).toBe(true);
		expect(noteBodySchema.safeParse('x'.repeat(10_001)).success).toBe(false);
		expect(noteBodySchema.parse('<script>alert(1)</script>')).toBe('<script>alert(1)</script>');
	});

	it('keeps notes per machine and refuses a removed machine', async () => {
		const database = testDatabase();
		const { machineId, ada } = await setUp(database);
		const other = enrolFakeAgent(database, NOW);
		addNote(database, machineId, ada, 'On this one', NOW + 1);
		expect(listNotes(database, other.machineId, ada)).toEqual([]);
		removeMachine(database, other.machineId, ada.id, NOW + 2);
		expect(addNote(database, other.machineId, ada, 'Too late', NOW + 3)).toBeUndefined();
	});
});

describe('who may add, edit and delete notes (D4)', () => {
	it('lets anyone who can see the machine add one (admins, and members through a rule)', async () => {
		const database = testDatabase();
		const { machineId, ada, mo } = await setUp(database);
		expect(canSeeMachine(database, ada, machineId)).toBe(true);
		expect(canSeeMachine(database, mo, machineId)).toBe(false);
		grantAccess(database, {
			adminId: ada.id,
			name: 'Helpdesk',
			memberIds: [mo.id],
			machineIds: [machineId],
			permissions: ['view'],
			consent: 'ask'
		});
		expect(canSeeMachine(database, mo, machineId)).toBe(true);
		expect(addNote(database, machineId, mo, 'Checked the printer.', NOW + 1)).toMatchObject({
			authorName: 'mo'
		});
	});

	it('lets only the author edit, and marks the note edited', async () => {
		const database = testDatabase();
		const { machineId, ada, ben } = await setUp(database);
		const note = addNote(database, machineId, ada, 'First go', NOW + 1);
		if (note === undefined) throw new Error('note not added');
		expect(note.canEdit).toBe(true);
		expect(listNotes(database, machineId, ben)[0]).toMatchObject({
			canEdit: false,
			canDelete: true
		});

		expect(editNote(database, machineId, note.id, ben, 'Not mine', NOW + 2)).toEqual({
			kind: 'not-allowed'
		});
		expect(editNote(database, machineId, note.id, ada, 'Second go', NOW + 3)).toMatchObject({
			kind: 'done',
			value: {
				body: 'Second go',
				edited: { kind: 'yes', editedIso: new Date(NOW + 3).toISOString() }
			}
		});
		expect(listNotes(database, machineId, ada)[0]).toMatchObject({
			body: 'Second go',
			createdIso: new Date(NOW + 1).toISOString(),
			edited: { kind: 'yes' }
		});
	});

	it('lets the author or an admin delete; deleted notes leave the list but keep their row', async () => {
		const database = testDatabase();
		const { machineId, ada, ben, mo } = await setUp(database);
		const own = addNote(database, machineId, mo, 'Member note', NOW + 1);
		const adas = addNote(database, machineId, ada, 'Admin note', NOW + 2);
		if (own === undefined || adas === undefined) throw new Error('notes not added');

		// A member who is not the author may not delete someone else's note.
		expect(deleteNote(database, machineId, adas.id, mo, NOW + 3)).toEqual({
			kind: 'not-allowed'
		});
		// The author may.
		expect(deleteNote(database, machineId, own.id, mo, NOW + 4)).toEqual({
			kind: 'done',
			value: null
		});
		// Any admin may.
		expect(deleteNote(database, machineId, adas.id, ben, NOW + 5)).toEqual({
			kind: 'done',
			value: null
		});
		expect(listNotes(database, machineId, ada)).toEqual([]);
		expect(deleteNote(database, machineId, adas.id, ada, NOW + 6)).toEqual({ kind: 'not-found' });
		expect(editNote(database, machineId, own.id, mo, 'Back?', NOW + 7)).toEqual({
			kind: 'not-found'
		});
	});

	it('finds a note only under its own machine', async () => {
		const database = testDatabase();
		const { machineId, ada } = await setUp(database);
		const other = enrolFakeAgent(database, NOW);
		const note = addNote(database, machineId, ada, 'Here', NOW + 1);
		if (note === undefined) throw new Error('note not added');
		expect(editNote(database, other.machineId, note.id, ada, 'There', NOW + 2)).toEqual({
			kind: 'not-found'
		});
		expect(deleteNote(database, other.machineId, note.id, ada, NOW + 2)).toEqual({
			kind: 'not-found'
		});
	});
});

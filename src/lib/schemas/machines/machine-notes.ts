import { z } from 'zod';

/** A note's text (SPEC-MACHINE-DETAILS D3): plain text, 1 to 10 000 characters, line breaks kept. */
export const noteBodySchema = z
	.string()
	.trim()
	.min(1, 'Write something first.')
	.max(10_000, 'A note is at most 10 000 characters.');

/** POST /api/machines/<id>/notes and PATCH …/notes/<noteId>. */
export const noteRequestSchema = z.object({ body: noteBodySchema });

/** One note as the Notes tab shows it. `canEdit`/`canDelete` are for the person asking. */
const noteViewSchema = z.object({
	id: z.uuid(),
	authorName: z.string(),
	body: z.string(),
	createdIso: z.iso.datetime(),
	edited: z.discriminatedUnion('kind', [
		z.object({ kind: z.literal('no') }),
		z.object({ kind: z.literal('yes'), editedIso: z.iso.datetime() })
	]),
	canEdit: z.boolean(),
	canDelete: z.boolean()
});

export type NoteView = z.infer<typeof noteViewSchema>;

export const noteReplySchema = z.object({ note: noteViewSchema });

export const deleteNoteReplySchema = z.object({ deleted: z.literal(true) });

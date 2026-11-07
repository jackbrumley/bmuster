import { z } from 'zod';

/** A machine's name (SPEC-MACHINE-DETAILS D1): one line, 1 to 80 characters. */
export const machineNameSchema = z
	.string()
	.trim()
	.min(1, 'Give the machine a name.')
	.max(80, 'A name is at most 80 characters.')
	.refine((name) => !/[\r\n]/.test(name), 'A name is one line.');

/** What the machine is for (D2): plain text, up to 500 characters, may be empty. */
export const machineDescriptionSchema = z
	.string()
	.trim()
	.max(500, 'A description is at most 500 characters.');

/** PATCH /api/machines/<id>: the name and description together, as the Edit details form saves them. */
export const updateMachineDetailsRequestSchema = z.object({
	name: machineNameSchema,
	description: machineDescriptionSchema
});

export const machineDetailsReplySchema = z.object({ name: z.string(), description: z.string() });

import { z } from 'zod';

export const diagnosticJournalSchema = z.discriminatedUnion('kind', [
	z.object({
		kind: z.literal('available'),
		lines: z.array(z.string().max(4096)).max(250),
		truncated: z.boolean()
	}),
	z.object({ kind: z.literal('unavailable'), reason: z.string().max(1000) }),
	z.object({ kind: z.literal('unsupported') })
]);

export const agentDiagnosticsReplySchema = z.object({
	agentVersion: z.string().min(1).max(64),
	capturedAtIso: z.iso.datetime(),
	lines: z.array(z.string().max(4096)).max(200),
	truncated: z.boolean(),
	journal: diagnosticJournalSchema
});

export type AgentDiagnosticsReply = z.infer<typeof agentDiagnosticsReplySchema>;

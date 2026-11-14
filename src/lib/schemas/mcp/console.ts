import { z } from 'zod';

/** The console's requests and replies for AI assistants (SPEC-MCP M1, M10, M14). */

export const mcpSettingsRequestSchema = z.object({
	enabled: z.boolean(),
	userGroupId: z.uuid().nullable()
});

export const mcpSettingsReplySchema = z.object({
	enabled: z.boolean(),
	userGroupId: z.string().nullable()
});

export const disconnectedReplySchema = z.object({ disconnected: z.literal(true) });

export const stoppedReplySchema = z.object({ grantsEnded: z.int() });

/** PUT /api/mcp/approvers: who may approve an AI assistant's command (SPEC-MCP M19). */
export const approverSettingsRequestSchema = z.discriminatedUnion('mode', [
	z.object({ mode: z.literal('requester') }),
	z.object({ mode: z.enum(['requester-or-group', 'group-only']), groupId: z.uuid() })
]);

export const approverSettingsReplySchema = z.object({ saved: z.literal(true) });

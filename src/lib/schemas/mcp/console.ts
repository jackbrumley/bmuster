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

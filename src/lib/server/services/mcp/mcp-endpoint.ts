import { createMcpHandler, McpServer, type CallToolResult } from '@modelcontextprotocol/server';
import {
	getMachineInput,
	getMachineOutput,
	listMachinesInput,
	listMachinesOutput
} from '#lib/schemas/mcp/tools.ts';
import {
	getMachineTool,
	listMachinesTool,
	type ToolContext,
	type ToolResult
} from './machine-tools.ts';

/**
 * `/mcp` (SPEC-MCP M4, 7): Streamable HTTP through `@modelcontextprotocol/server`, which serves
 * revision 2026-07-28 and, through its stateless fallback, the 2025-11-25 `initialize`
 * handshake. BMuster keeps no MCP session state: each request gets a fresh server whose tools act
 * as the person behind the bearer token the route's guard already checked.
 */

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, openWorldHint: false } as const;

function toCallResult<T extends Record<string, unknown>>(result: ToolResult<T>): CallToolResult {
	switch (result.kind) {
		case 'ok':
			return {
				content: [{ type: 'text', text: JSON.stringify(result.output) }],
				structuredContent: result.output
			};
		case 'error':
			return { content: [{ type: 'text', text: result.message }], isError: true };
	}
}

function bmusterMcpServer(context: ToolContext): McpServer {
	const server = new McpServer(
		{ name: 'BMuster', version: __BMUSTER_VERSION__ },
		{
			instructions:
				'BMuster manages computers. You act as the signed-in person and see only the machines an access rule opens to AI commands.'
		}
	);
	server.registerTool(
		'list_machines',
		{
			title: 'List machines',
			description:
				'Lists the machines you may see in BMuster: name, host name, system, status and shells. Only machines an access rule opens to AI commands.',
			inputSchema: listMachinesInput,
			outputSchema: listMachinesOutput,
			annotations: READ_ONLY
		},
		(input) => toCallResult(listMachinesTool(context, input))
	);
	server.registerTool(
		'get_machine',
		{
			title: 'Get a machine',
			description:
				"One machine's inventory: system, status, CPU, memory, disks, who is signed in, what is in use, and its recent activity.",
			inputSchema: getMachineInput,
			outputSchema: getMachineOutput,
			annotations: READ_ONLY
		},
		(input) => toCallResult(getMachineTool(context, input))
	);
	return server;
}

/** Answers one `POST /mcp` for an authenticated principal. */
export function serveMcp(
	request: Request,
	context: ToolContext,
	onError: (error: Error) => void
): Promise<Response> {
	const handler = createMcpHandler(() => bmusterMcpServer(context), { onerror: onError });
	return handler.fetch(request);
}

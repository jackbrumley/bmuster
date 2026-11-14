/**
 * AI assistants connected over MCP (SPEC-MCP). Any assistant that speaks MCP can connect:
 * Claude, ChatGPT or another. Browser-safe: the shapes the console and the server share.
 */

/** What a token may be used for (SPEC-MCP 8.2). Step 1 advertises these two. */
export const MCP_SCOPES = ['machines:read', 'offline_access'] as const;

export type McpScope = (typeof MCP_SCOPES)[number];

/** A client that asks for no scope gets read access only, without a refresh token. */
export const DEFAULT_SCOPES: readonly McpScope[] = ['machines:read'];

export function isMcpScope(scope: string): scope is McpScope {
	return MCP_SCOPES.some((known) => known === scope);
}

/** What the consent screen says each scope allows. */
export function scopeLabel(scope: McpScope): string {
	switch (scope) {
		case 'machines:read':
			return 'See the machines where an access rule gives you AI commands: names, systems, status, disks and recent activity.';
		case 'offline_access':
			return 'Stay connected until you disconnect it, or for 30 days.';
	}
}

/** How long after its last use a grant counts as "connected" in the console header (M15). */
export const CONNECTED_WINDOW_MS = 10 * 60_000;

/**
 * Who a client is: a Client ID Metadata Document ties its name to the host that serves the
 * document (verified); a registered client's name is only its own claim (unverified).
 */
export type ClientIdentity = { kind: 'verified'; host: string } | { kind: 'unverified' };

export type AssistantName = { name: string; identity: ClientIdentity };

/** "Claude Code", or "unverified client Foo": how Activity and the console name a client. */
export function assistantLabel(assistant: AssistantName): string {
	switch (assistant.identity.kind) {
		case 'verified':
			return assistant.name;
		case 'unverified':
			return `unverified client ${assistant.name}`;
	}
}

/** Where the consent screen says the browser goes back to after Allow. */
export type RedirectTarget = { kind: 'web'; host: string } | { kind: 'loopback' };

/** One connection as the Account page and Settings → AI assistants list it. */
export type GrantView = {
	id: string;
	assistant: AssistantName;
	userName: string;
	createdIso: string;
	lastUsed: { kind: 'never' } | { kind: 'used'; atIso: string; ip: string };
	/** Used within the last 10 minutes. */
	active: boolean;
};

/** The person's assistant in use right now, for the console header (M15). */
export type AssistantStatus = { kind: 'none' } | { kind: 'connected'; name: string };

/** The connect group as Settings → AI assistants shows it. */
export type McpGroupChoice =
	| { kind: 'none' }
	| { kind: 'group'; id: string; name: string }
	/** The setting names a group that has since been deleted: nobody may connect. */
	| { kind: 'missing'; id: string };

export type McpSettingsView = { enabled: boolean; userGroup: McpGroupChoice };

/** Whether AI assistants can connect now, and whether this person may connect one. */
export type ConnectState = 'on' | 'off' | 'not-allowed';

/** The address people paste into their assistant: this server's own `/mcp`. */
export function mcpServerUrl(origin: string): string {
	return `${origin}/mcp`;
}

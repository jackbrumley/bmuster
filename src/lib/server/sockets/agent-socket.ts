import { agentSocketMessageSchema } from '#lib/schemas/agents/agent-protocol.ts';
import { database } from '../database/app-database.ts';
import { isRefusal } from '../services/agents/agent-refusal.ts';
import { authenticateAgent } from '../services/agents/agent-auth.ts';
import { pinUpdate } from '../services/agents/local-tls.ts';
import { receiveAgentDiagnostics } from '../services/agents/diagnostics.ts';
import { servedCertificate } from '../tls/served-certificate.ts';
import {
	agentConnected,
	agentDisconnected,
	recordLiveFigures,
	type LivePeer
} from '../services/agents/live-agents.ts';
import { socketClosed, socketOpened } from '../services/agents/presence.ts';
import { sessionRelay } from '../services/sessions/relay.ts';
import { defineSocketRoute } from './socket-route.ts';

const AGENT_SOCKET_PATH = '/agent/v1/socket';

/**
 * An agent's live socket (SPEC-ENROLMENT 8): signed upgrade, live figures
 * and session refusals in, commands and session requests out. Session bytes
 * travel on each session's own socket (session-sockets.ts).
 */
export const agentSocketRoute = defineSocketRoute<{
	machineId: string;
	peer: LivePeer | undefined;
}>({
	path: AGENT_SOCKET_PATH,
	upgrade(request) {
		const agent = authenticateAgent(
			database,
			{
				method: 'GET',
				path: AGENT_SOCKET_PATH,
				authorization: request.headers.get('authorization'),
				body: new Uint8Array()
			},
			Date.now()
		);
		if (isRefusal(agent)) {
			return Promise.resolve({
				refused: true,
				status: agent.status,
				reason: agent.reason,
				message: agent.message
			});
		}
		return Promise.resolve({ machineId: agent.machineId, peer: undefined });
	},
	open(peer) {
		const live: LivePeer = {
			send: (message) => {
				peer.send(JSON.stringify(message));
			},
			close: (code, reason) => {
				peer.close(code, reason);
			}
		};
		peer.context.peer = live;
		agentConnected(peer.context.machineId, live);
		// Every connection hears which certificate to expect next (SPEC-INSTALL-OPTIONS L7).
		live.send(pinUpdate(database, servedCertificate()));
		socketOpened(database, peer.context.machineId, Date.now());
	},
	message(peer, data) {
		if (new TextEncoder().encode(data).byteLength > 256 * 1024) {
			peer.close(4002, 'Message too large');
			return;
		}
		let json: unknown;
		try {
			json = JSON.parse(data);
		} catch {
			peer.close(4002, 'Not JSON');
			return;
		}
		const parsed = agentSocketMessageSchema.safeParse(json);
		if (!parsed.success) {
			peer.close(4002, 'Unknown message');
			return;
		}
		switch (parsed.data.type) {
			case 'live':
				recordLiveFigures(peer.context.machineId, {
					cpuPercent: parsed.data.cpuPercent,
					memoryUsedBytes: parsed.data.memoryUsedBytes,
					atMs: Date.now()
				});
				return;
			case 'session-refused':
				sessionRelay().refusedByAgent(
					parsed.data.sessionId,
					peer.context.machineId,
					parsed.data.message
				);
				return;
			case 'diagnostics':
				receiveAgentDiagnostics(peer.context.machineId, parsed.data);
				return;
		}
	},
	binary(peer) {
		peer.close(4002, 'Binary messages belong on a session socket');
	},
	close(peer) {
		// A connection replaced by a newer one from the same machine leaves it online.
		if (
			peer.context.peer !== undefined &&
			agentDisconnected(peer.context.machineId, peer.context.peer)
		) {
			socketClosed(database, peer.context.machineId, Date.now());
		}
	}
});

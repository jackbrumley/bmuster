import { database } from '../database/app-database.ts';
import { isRefusal } from '../services/agents/agent-refusal.ts';
import { authenticateAgent } from '../services/agents/agent-auth.ts';
import { sessionRelay, type RelayPeer } from '../services/sessions/relay.ts';
import { defineSocketRoute, type SocketPeer } from './socket-route.ts';

/**
 * Each session's two sockets (SPEC-SESSIONS T4): the agent's, opened with a
 * signed upgrade like its live socket, and the browser's, opened with the
 * single-use ticket from an authenticated request (never a cookie, AGENTS.md
 * §6). The relay joins them; terminal, files and exec sessions all use these.
 */

type SessionContext = { sessionId: string; relayPeer: RelayPeer | undefined };

function relayPeerOf(peer: SocketPeer<SessionContext>): RelayPeer {
	return {
		sendText: (text) => {
			peer.send(text);
		},
		sendBytes: (data, sent) => {
			peer.sendBinary(data, sent);
		},
		pause: () => {
			peer.pause();
		},
		resume: () => {
			peer.resume();
		},
		close: (code, reason) => {
			peer.close(code, reason);
		}
	};
}

/** The peer the relay knows this connection by, made once it opens. */
function opened(peer: SocketPeer<SessionContext>): RelayPeer {
	const relayPeer = relayPeerOf(peer);
	peer.context.relayPeer = relayPeer;
	return relayPeer;
}

export const agentSessionSocketRoute = defineSocketRoute<SessionContext & { machineId: string }>({
	path: '/agent/v1/sessions/[id]',
	upgrade(request, params) {
		const pathname = new URL(request.url).pathname;
		const agent = authenticateAgent(
			database,
			{
				method: 'GET',
				path: pathname,
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
		const sessionId = params['id'] ?? '';
		if (!sessionRelay().isRunning(sessionId)) {
			return Promise.resolve({
				refused: true,
				status: 404,
				reason: 'not-found',
				message: 'No such session.'
			});
		}
		return Promise.resolve({ sessionId, machineId: agent.machineId, relayPeer: undefined });
	},
	open(peer) {
		const attached = sessionRelay().attachAgent(
			peer.context.sessionId,
			peer.context.machineId,
			opened(peer)
		);
		if (attached.kind === 'refused') {
			peer.context.relayPeer = undefined;
			peer.close(4004, attached.message);
		}
	},
	message(peer, data) {
		if (peer.context.relayPeer !== undefined) {
			sessionRelay().agentText(peer.context.sessionId, peer.context.relayPeer, data);
		}
	},
	binary(peer, data) {
		if (peer.context.relayPeer !== undefined) {
			sessionRelay().fromAgent(peer.context.sessionId, peer.context.relayPeer, data);
		}
	},
	close(peer) {
		if (peer.context.relayPeer !== undefined) {
			sessionRelay().agentClosed(peer.context.sessionId, peer.context.relayPeer);
		}
	}
});

export const browserSessionSocketRoute = defineSocketRoute<SessionContext>({
	path: '/api/sessions/[id]/socket',
	upgrade(request, params) {
		const sessionId = params['id'] ?? '';
		const ticket = new URL(request.url).searchParams.get('ticket') ?? '';
		if (!sessionRelay().redeemBrowserTicket(sessionId, ticket)) {
			return Promise.resolve({
				refused: true,
				status: 401,
				reason: 'bad-ticket',
				message: 'This session link has expired. Open the terminal again.'
			});
		}
		return Promise.resolve({ sessionId, relayPeer: undefined });
	},
	open(peer) {
		const attached = sessionRelay().attachBrowser(peer.context.sessionId, opened(peer));
		if (attached.kind === 'refused') {
			peer.context.relayPeer = undefined;
			peer.close(4004, attached.message);
		}
	},
	message(peer, data) {
		if (peer.context.relayPeer !== undefined) {
			sessionRelay().browserText(peer.context.sessionId, peer.context.relayPeer, data);
		}
	},
	binary(peer, data) {
		if (peer.context.relayPeer !== undefined) {
			sessionRelay().fromBrowser(peer.context.sessionId, peer.context.relayPeer, data);
		}
	},
	close(peer) {
		if (peer.context.relayPeer !== undefined) {
			sessionRelay().browserClosed(peer.context.sessionId, peer.context.relayPeer);
		}
	}
});

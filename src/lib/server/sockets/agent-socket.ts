import { agentSocketMessageSchema } from '#lib/schemas/agents/agent-protocol.ts';
import { database } from '../database/app-database.ts';
import { isRefusal } from '../services/agents/agent-refusal.ts';
import { authenticateAgent } from '../services/agents/agent-auth.ts';
import { pinUpdate } from '../services/agents/local-tls.ts';
import { servedCertificate } from '../tls/served-certificate.ts';
import {
	agentConnected,
	agentDisconnected,
	recordLiveFigures,
	type LivePeer
} from '../services/agents/live-agents.ts';
import { socketClosed, socketOpened } from '../services/agents/presence.ts';
import { storeLogBatch } from '../services/logs/agent-logs.ts';
import { powerPolicyOnConnect } from '../services/machines/power-policy.ts';
import { storeCheckResults } from '../services/logs/machine-checks.ts';
import { serverLog } from '../services/logs/server-log.ts';
import { verboseOnConnect } from '../services/logs/verbose.ts';
import { sessionRelay } from '../services/sessions/relay.ts';
import { defineSocketRoute } from './socket-route.ts';

const AGENT_SOCKET_PATH = '/agent/v1/socket';

/**
 * An agent's live socket (SPEC-ENROLMENT 8): signed upgrade, live figures,
 * session refusals, log batches and check results in, commands, session requests and log
 * acknowledgements out. Session bytes travel on each session's own socket
 * (session-sockets.ts). Log records are stored for the socket's own machine
 * only (SPEC-AGENT-LOGS 2).
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
		const now = Date.now();
		// A verbose window outlives a reconnect, not a restart of the agent (SPEC-AGENT-LOGS 1).
		const verbose = verboseOnConnect(database, peer.context.machineId, now);
		if (verbose !== undefined) {
			live.send(verbose);
		}
		// Every connection hears the stay-awake setting, so a change made while it was offline lands.
		live.send(powerPolicyOnConnect(database, peer.context.machineId));
		socketOpened(database, peer.context.machineId, now);
		serverLog('info', 'agents', 'Live socket opened.', peer.context.machineId, now);
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
			case 'log-batch': {
				const result = storeLogBatch(database, peer.context.machineId, parsed.data, Date.now());
				// A rate-limited batch is not acknowledged: the agent sends it again once it has waited.
				if (result.kind === 'stored') {
					peer.context.peer?.send({
						type: 'log-ack',
						instance: parsed.data.instance,
						seq: result.ackSeq
					});
				}
				return;
			}
			case 'checks':
				// Results after Run checks, for the socket's own machine (SPEC-DIAGNOSTICS 1).
				storeCheckResults(database, peer.context.machineId, parsed.data.results, Date.now());
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
			serverLog('info', 'agents', 'Live socket closed.', peer.context.machineId);
		}
	}
});

import { eq } from 'drizzle-orm';
import { agentSocketMessageSchema } from '#lib/schemas/agents/agent-protocol.ts';
import { database } from '../database/app-database.ts';
import { machines } from '../database/schema.ts';
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
import { defineSocketRoute } from './socket-route.ts';

const AGENT_SOCKET_PATH = '/agent/v1/socket';

/** An agent's live socket (SPEC-ENROLMENT 8): signed upgrade, live figures in, commands out. */
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
		touch(peer.context.machineId);
	},
	message(peer, data) {
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
		// The only message so far; more types become a switch.
		recordLiveFigures(peer.context.machineId, {
			cpuPercent: parsed.data.cpuPercent,
			memoryUsedBytes: parsed.data.memoryUsedBytes,
			atMs: Date.now()
		});
	},
	close(peer) {
		if (peer.context.peer !== undefined) {
			agentDisconnected(peer.context.machineId, peer.context.peer);
		}
		touch(peer.context.machineId);
	}
});

function touch(machineId: string): void {
	database.update(machines).set({ lastSeenAt: new Date() }).where(eq(machines.id, machineId)).run();
}

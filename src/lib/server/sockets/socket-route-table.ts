import { agentSocketRoute } from './agent-socket.ts';
import { agentSessionSocketRoute, browserSessionSocketRoute } from './session-sockets.ts';
import type { SocketRoute } from './socket-route.ts';

/** Every socket route the server serves. */
export const SOCKET_ROUTES: readonly SocketRoute[] = [
	agentSocketRoute,
	agentSessionSocketRoute,
	browserSessionSocketRoute
];

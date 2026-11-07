import { agentSocketRoute } from './agent-socket.ts';
import type { SocketRoute } from './socket-route.ts';

/** Every socket route the server serves. */
export const SOCKET_ROUTES: readonly SocketRoute[] = [agentSocketRoute];

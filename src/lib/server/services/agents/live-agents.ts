import type { ServerSocketMessage } from '#lib/schemas/agents/agent-protocol.ts';

/**
 * Agents connected to this server process right now, and their latest live
 * figures. Process-local by design: BMuster runs as one instance (AGENTS.md §3).
 */
export type LivePeer = {
	send(message: ServerSocketMessage): void;
	close(code: number, reason: string): void;
};

type LiveFigures = { cpuPercent: number; memoryUsedBytes: number; atMs: number };

type LiveState = {
	peers: Map<string, LivePeer>;
	figures: Map<string, LiveFigures>;
	watchTimers: Map<string, ReturnType<typeof setTimeout>>;
};

/**
 * Kept on globalThis: the dev server can load this module more than once (the
 * socket route and the pages through different module runners), and every
 * copy must see the same connected agents.
 */
const STATE_KEY = Symbol.for('bmuster.live-agents');

function liveState(): LiveState {
	const existing: unknown = Reflect.get(globalThis, STATE_KEY);
	if (isLiveState(existing)) {
		return existing;
	}
	const created: LiveState = { peers: new Map(), figures: new Map(), watchTimers: new Map() };
	Reflect.set(globalThis, STATE_KEY, created);
	return created;
}

function isLiveState(value: unknown): value is LiveState {
	return (
		typeof value === 'object' &&
		value !== null &&
		'peers' in value &&
		value.peers instanceof Map &&
		'figures' in value &&
		value.figures instanceof Map &&
		'watchTimers' in value &&
		value.watchTimers instanceof Map
	);
}

const { peers, figures, watchTimers } = liveState();

export function agentConnected(machineId: string, peer: LivePeer): void {
	// A second connection from the same machine replaces the first.
	peers.get(machineId)?.close(4000, 'Replaced by a newer connection');
	peers.set(machineId, peer);
	if (watchTimers.has(machineId)) {
		peer.send({ type: 'watch', intervalMs: WATCH_INTERVAL_MS });
	}
}

export function agentDisconnected(machineId: string, peer: LivePeer): void {
	if (peers.get(machineId) === peer) {
		peers.delete(machineId);
		figures.delete(machineId);
	}
}

export function isAgentConnected(machineId: string): boolean {
	return peers.has(machineId);
}

/** Sends a message if the agent is connected; returns whether it was sent. */
export function sendToAgent(machineId: string, message: ServerSocketMessage): boolean {
	const peer = peers.get(machineId);
	if (peer === undefined) {
		return false;
	}
	peer.send(message);
	return true;
}

export function sendToAllAgents(message: ServerSocketMessage): void {
	for (const peer of peers.values()) {
		peer.send(message);
	}
}

/** Closes an agent's socket, e.g. when its machine is removed. */
export function disconnectAgent(machineId: string, code: number, reason: string): void {
	peers.get(machineId)?.close(code, reason);
	peers.delete(machineId);
	figures.delete(machineId);
}

export function recordLiveFigures(machineId: string, live: LiveFigures): void {
	figures.set(machineId, live);
}

export function liveFigures(machineId: string): LiveFigures | undefined {
	return figures.get(machineId);
}

/** How often a watched agent sends live figures, and how long a watch lasts without renewal. */
const WATCH_INTERVAL_MS = 2000;
const WATCH_TTL_MS = 15_000;

/**
 * Someone is looking at this machine: ask its agent to stream live figures
 * (SPEC-ENROLMENT 8). Each call renews the watch; it lapses 15 s after the last.
 */
export function watchAgent(machineId: string): void {
	const existing = watchTimers.get(machineId);
	if (existing === undefined) {
		sendToAgent(machineId, { type: 'watch', intervalMs: WATCH_INTERVAL_MS });
	} else {
		clearTimeout(existing);
	}
	const timer = setTimeout(() => {
		watchTimers.delete(machineId);
		sendToAgent(machineId, { type: 'unwatch' });
	}, WATCH_TTL_MS);
	timer.unref();
	watchTimers.set(machineId, timer);
}

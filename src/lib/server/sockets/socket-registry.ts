import { isSocketRoute, type SocketRoute } from './socket-route.ts';

/**
 * Hands the socket routes from the built app to server.ts. hooks.server.ts
 * registers them in `init`; server.ts reads them back, so both use the same
 * module instances (the live-agent registry above all).
 */
const REGISTRY_KEY = Symbol.for('bmuster.socket-routes');

export function registerSocketRoutes(routes: readonly SocketRoute[]): void {
	Reflect.set(globalThis, REGISTRY_KEY, routes);
}

export function registeredSocketRoutes(): SocketRoute[] {
	const routes: unknown = Reflect.get(globalThis, REGISTRY_KEY);
	if (!Array.isArray(routes)) {
		throw new Error('Socket routes were not registered (hooks.server.ts init)');
	}
	return routes.filter(isSocketRoute);
}

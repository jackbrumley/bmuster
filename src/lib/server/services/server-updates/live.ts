import { database } from '../../database/app-database.ts';
import { env } from '../../env.ts';
import { makeServerUpdates, type ServerUpdates } from './service.ts';

const KEY = Symbol.for('bmuster.server-updates');
function isService(value: unknown): value is ServerUpdates {
	return (
		typeof value === 'object' &&
		value !== null &&
		'view' in value &&
		typeof value.view === 'function' &&
		'check' in value &&
		typeof value.check === 'function'
	);
}
export function serverUpdates(): ServerUpdates {
	const held: unknown = Reflect.get(globalThis, KEY);
	if (isService(held)) return held;
	const created = makeServerUpdates(database, env.launcher);
	Reflect.set(globalThis, KEY, created);
	return created;
}
export function startUpdateChecks(log: (line: string) => void): void {
	const timerKey = Symbol.for('bmuster.server-update-timer');
	if (Reflect.get(globalThis, timerKey) === true) return;
	Reflect.set(globalThis, timerKey, true);
	const check = (): void => {
		if (serverUpdates().due(Date.now()))
			void serverUpdates()
				.check(null, Date.now())
				.catch((error: unknown) => {
					log(
						`Server update check failed: ${error instanceof Error ? error.message : String(error)}`
					);
				});
	};
	check();
	const timer = setInterval(check, 60_000);
	timer.unref();
}

import { AGENT_TARGETS } from '#lib/domain/machines/agent-release.ts';
import { database } from '../../database/app-database.ts';
import { env } from '../../env.ts';
import { download, RELEASE_PUBLIC_KEY } from '../server-updates/release.ts';
import { getSetting } from '../settings/settings.ts';
import { signedReleases } from './releases.ts';
import { fetchTestBuild, TestChannel } from './test-builds.ts';
import { builtInGroupMachineIds, newestVersion } from './update-channels.ts';

/** The running server's Test channel (SPEC-TEST-CHANNEL), one per process. */
const KEY = Symbol.for('bmuster.test-channel');

function isChannel(value: unknown): value is TestChannel {
	return value instanceof TestChannel;
}

export function testChannel(): TestChannel {
	const held: unknown = Reflect.get(globalThis, KEY);
	if (isChannel(held)) return held;
	const created = new TestChannel(
		() =>
			fetchTestBuild({
				folder: env.agentTestBuildsPath,
				newestFull: newestVersion(
					signedReleases(env.releasesPath, env.agentTestBuildsPath).full,
					AGENT_TARGETS
				)?.version,
				get: download,
				publicKey: RELEASE_PUBLIC_KEY
			}),
		() => builtInGroupMachineIds(database, 'test').size > 0
	);
	Reflect.set(globalThis, KEY, created);
	return created;
}

export function startTestChannelChecks(log: (line: string) => void): void {
	const timerKey = Symbol.for('bmuster.test-channel-timer');
	if (Reflect.get(globalThis, timerKey) === true) return;
	Reflect.set(globalThis, timerKey, true);
	const check = (): void => {
		const now = Date.now();
		if (!testChannel().due(now, getSetting(database, 'serverUpdateChecks'))) return;
		void testChannel()
			.check(now)
			.then(() => {
				const problem = testChannel().status().problem;
				if (problem !== null) log(`Test channel check failed: ${problem}`);
			});
	};
	check();
	const timer = setInterval(check, 60_000);
	timer.unref();
}

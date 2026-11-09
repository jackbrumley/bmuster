import { afterEach, describe, expect, it, vi } from 'vitest';
import { serverLogRecords } from '#lib/server/database/schema.ts';
import { testDatabase } from '#tests/helpers/fake-agent.ts';
import { NOW } from '#tests/helpers/people.ts';
import { serverLog, stopStoringServerLogs, storeServerLogs } from './server-log.ts';

describe('the server log (SPEC-AGENT-LOGS AL8)', () => {
	afterEach(() => {
		stopStoringServerLogs();
	});

	it('AL8: stores its own records with area and machine where known, and still writes them out', () => {
		const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
		const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
		const database = testDatabase();

		serverLog('info', 'server', 'before the store opens', null, NOW);
		storeServerLogs(database, 'instance-1');
		serverLog('info', 'agents', 'Live socket opened.', 'machine-1', NOW + 1);
		serverLog('warn', 'relay', 'A session socket closed early.', null, NOW + 2);
		serverLog('error', 'http', `Error ab12: ${'x'.repeat(5000)}`, null, NOW + 3);

		const rows = database.select().from(serverLogRecords).all();
		expect(rows.map((row) => [row.seq, row.level, row.area, row.machineId])).toEqual([
			[1, 'info', 'agents', 'machine-1'],
			[2, 'warn', 'relay', null],
			[3, 'error', 'http', null]
		]);
		expect(rows.every((row) => row.instance === 'instance-1')).toBe(true);
		expect(rows[0]?.at).toEqual(new Date(NOW + 1));
		expect(rows[2]?.text.length).toBeLessThanOrEqual(4096);
		expect(rows[2]?.text).toMatch(/\[cut \d+ characters\]$/);

		expect(stdout).toHaveBeenCalledWith('[server] before the store opens\n');
		expect(stdout).toHaveBeenCalledWith('[agents] Live socket opened.\n');
		expect(stderr).toHaveBeenCalledWith('[relay] A session socket closed early.\n');
	});

	it('AL8: a store that fails is reported on standard error, not thrown', () => {
		const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
		vi.spyOn(process.stdout, 'write').mockReturnValue(true);
		const database = testDatabase();
		storeServerLogs(database, 'instance-2');
		database.$client.close();
		expect(() => {
			serverLog('info', 'agents', 'after the database closed', null, NOW);
		}).not.toThrow();
		expect(stderr).toHaveBeenCalledWith(
			expect.stringMatching(/^\[logs\] Could not store a server log record/)
		);
	});
});

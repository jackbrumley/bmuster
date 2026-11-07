import { generateKeyPairSync, sign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { enrolFakeAgent, testDatabase } from '#tests/helpers/fake-agent.ts';
import { removeMachine } from '../machines/machine-views.ts';
import { authenticateAgent } from './agent-auth.ts';
import { requestMessage } from './signing.ts';

const NOW = 1_794_000_000_000;
const PATH = '/agent/v1/check-in';

describe('signed agent requests (A5, A9)', () => {
	it('accepts a correctly signed request', () => {
		const database = testDatabase();
		const agent = enrolFakeAgent(database, NOW);
		expect(authenticateAgent(database, agent.signed('POST', PATH, '{}', NOW), NOW)).toEqual({
			machineId: agent.machineId,
			checkInSeconds: 60
		});
	});

	it('refuses a request signed with another key, or for another path or body', () => {
		const database = testDatabase();
		const agent = enrolFakeAgent(database, NOW);
		const stranger = generateKeyPairSync('ed25519');
		const forged = sign(
			null,
			requestMessage('POST', PATH, NOW, Buffer.from('{}')),
			stranger.privateKey
		);
		const request = {
			method: 'POST',
			path: PATH,
			authorization: `BMuster ${agent.machineId}:${NOW}:${forged.toString('base64')}`,
			body: Buffer.from('{}')
		};
		expect(authenticateAgent(database, request, NOW)).toMatchObject({ reason: 'bad-signature' });
		const signed = agent.signed('POST', PATH, '{}', NOW);
		expect(authenticateAgent(database, { ...signed, path: '/agent/v1/enrol' }, NOW)).toMatchObject({
			reason: 'bad-signature'
		});
		expect(
			authenticateAgent(database, { ...signed, body: Buffer.from('{"x":1}') }, NOW)
		).toMatchObject({ reason: 'bad-signature' });
	});

	it('refuses a stale timestamp and a replayed one', () => {
		const database = testDatabase();
		const agent = enrolFakeAgent(database, NOW);
		expect(
			authenticateAgent(database, agent.signed('POST', PATH, '{}', NOW - 6 * 60_000), NOW)
		).toMatchObject({ reason: 'stale-timestamp' });
		const request = agent.signed('POST', PATH, '{}', NOW);
		expect(authenticateAgent(database, request, NOW)).toMatchObject({ machineId: agent.machineId });
		expect(authenticateAgent(database, request, NOW)).toMatchObject({
			reason: 'replayed-timestamp'
		});
		expect(
			authenticateAgent(database, agent.signed('POST', PATH, '{}', NOW - 1), NOW)
		).toMatchObject({ reason: 'replayed-timestamp' });
	});

	it('refuses an unknown machine', () => {
		const database = testDatabase();
		const agent = enrolFakeAgent(database, NOW);
		const request = agent.signed('POST', PATH, '{}', NOW);
		const unknown =
			request.authorization?.replace(agent.machineId, '00000000-0000-4000-8000-000000000000') ??
			null;
		expect(authenticateAgent(database, { ...request, authorization: unknown }, NOW)).toMatchObject({
			reason: 'unknown-machine'
		});
	});

	it('refuses a removed machine with revoked (A9)', () => {
		const database = testDatabase();
		const agent = enrolFakeAgent(database, NOW);
		expect(removeMachine(database, agent.machineId, NOW)).toBe(true);
		expect(
			authenticateAgent(database, agent.signed('POST', PATH, '{}', NOW + 1), NOW + 1)
		).toMatchObject({
			reason: 'revoked',
			status: 401
		});
	});
});

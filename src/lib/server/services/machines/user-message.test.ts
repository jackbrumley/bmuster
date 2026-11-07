import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import type { ServerSocketMessage } from '#lib/schemas/agents/agent-protocol.ts';
import { userMessageRequestSchema } from '#lib/schemas/machines/user-message.ts';
import { toConsoleUser } from '#lib/server/services/users/users.ts';
import { grantAccess } from '#tests/helpers/access.ts';
import { enrolFakeAgent, testDatabase } from '#tests/helpers/fake-agent.ts';
import { addTestUser, NOW } from '#tests/helpers/people.ts';
import type { AppDatabase } from '../../database/connection.ts';
import { machines } from '../../database/schema.ts';
import { listAudit } from '../audit/audit.ts';
import { sendUserMessage } from './user-message.ts';

async function setUp(database: AppDatabase, osFamily: 'windows' | 'linux') {
	const machineId = enrolFakeAgent(database, NOW).machineId;
	database.update(machines).set({ osFamily }).where(eq(machines.id, machineId)).run();
	const ada = toConsoleUser(
		await addTestUser(database, { email: 'ada@example.com', role: 'admin', password: null })
	);
	const mo = toConsoleUser(
		await addTestUser(database, { email: 'mo@example.com', role: 'member', password: null })
	);
	return { machineId, ada, mo };
}

function connected(sent: ServerSocketMessage[]) {
	return (message: ServerSocketMessage) => {
		sent.push(message);
		return true;
	};
}

describe('sending a message to the person at a machine', () => {
	it('sends it to the agent as user-message and audits who sent what', async () => {
		const database = testDatabase();
		const { machineId, ada } = await setUp(database, 'windows');
		const sent: ServerSocketMessage[] = [];
		const result = sendUserMessage(
			database,
			ada,
			machineId,
			'Rebooting at 5',
			NOW,
			connected(sent)
		);
		expect(result).toEqual({ kind: 'sent' });
		expect(sent).toEqual([{ type: 'user-message', from: ada.name, text: 'Rebooting at 5' }]);
		expect(listAudit(database, 10).find((e) => e.kind === 'machine-message-sent')).toMatchObject({
			actorUserId: ada.id,
			target: 'Test machine',
			detail: { message: 'Rebooting at 5' }
		});
	});

	it('members need desktop control or a terminal; watching is not enough', async () => {
		const database = testDatabase();
		const { machineId, ada, mo } = await setUp(database, 'windows');
		const sent: ServerSocketMessage[] = [];
		expect(sendUserMessage(database, mo, machineId, 'hi', NOW, connected(sent))).toEqual({
			kind: 'not-found'
		});
		const rule = {
			adminId: ada.id,
			memberIds: [mo.id],
			machineIds: [machineId],
			consent: 'unattended' as const
		};
		grantAccess(database, { ...rule, name: 'Watchers', permissions: ['view', 'desktop-view'] });
		expect(sendUserMessage(database, mo, machineId, 'hi', NOW, connected(sent))).toEqual({
			kind: 'not-allowed'
		});
		grantAccess(database, { ...rule, name: 'Helpdesk', permissions: ['view', 'terminal'] });
		expect(sendUserMessage(database, mo, machineId, 'hi', NOW, connected(sent))).toEqual({
			kind: 'sent'
		});
		expect(sent).toHaveLength(1);
	});

	it('is Windows only, needs the agent online, and audits nothing it did not send', async () => {
		const database = testDatabase();
		const linux = await setUp(database, 'linux');
		const sent: ServerSocketMessage[] = [];
		expect(
			sendUserMessage(database, linux.ada, linux.machineId, 'hi', NOW, connected(sent))
		).toEqual({ kind: 'unsupported' });
		database.update(machines).set({ osFamily: 'windows' }).run();
		expect(sendUserMessage(database, linux.ada, linux.machineId, 'hi', NOW, () => false)).toEqual({
			kind: 'offline'
		});
		expect(sent).toEqual([]);
		expect(listAudit(database, 10).some((e) => e.kind === 'machine-message-sent')).toBe(false);
	});

	it('takes plain text of 1 to 500 characters', () => {
		expect(userMessageRequestSchema.safeParse({ text: '  ' }).success).toBe(false);
		expect(userMessageRequestSchema.safeParse({ text: 'x'.repeat(500) }).success).toBe(true);
		expect(userMessageRequestSchema.safeParse({ text: 'x'.repeat(501) }).success).toBe(false);
	});
});

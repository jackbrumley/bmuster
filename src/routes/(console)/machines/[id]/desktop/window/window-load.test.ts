import { isHttpError, type RequestEvent } from '@sveltejs/kit';
import { describe, expect, it } from 'vitest';
import type { Permission } from '#lib/domain/access/access.ts';
import type { ConsoleRole, ConsoleUser } from '#lib/domain/users/user.ts';
import { database } from '#lib/server/database/app-database.ts';
import { toConsoleUser } from '#lib/server/services/users/users.ts';
import { grantAccess } from '#tests/helpers/access.ts';
import { enrolFakeAgent } from '#tests/helpers/fake-agent.ts';
import { addTestUser, NOW } from '#tests/helpers/people.ts';
import { load } from './+page.server.ts';

// SPEC-DESKTOP-POPOUT PO8: the pop-out window checks access itself, since it skips the machine layout.

async function person(role: ConsoleRole): Promise<ConsoleUser> {
	const email = `${role}-${crypto.randomUUID()}@example.com`;
	return toConsoleUser(await addTestUser(database, { email, role, password: null }));
}

/** A member with these permissions on a new machine, given by a new admin. */
async function memberWith(permissions: Permission[]) {
	const admin = await person('admin');
	const member = await person('member');
	const machineId = enrolFakeAgent(database, NOW).machineId;
	if (permissions.length > 0) {
		grantAccess(database, {
			adminId: admin.id,
			name: `Helpdesk ${crypto.randomUUID()}`,
			memberIds: [member.id],
			machineIds: [machineId],
			permissions,
			consent: 'unattended'
		});
	}
	return { admin, member, machineId };
}

function opening(user: ConsoleUser, id: string): Parameters<typeof load>[0] {
	const url = new URL(`https://bmuster.test/machines/${id}/desktop/window`);
	const partial: Pick<RequestEvent, 'locals' | 'url' | 'request'> & { params: { id: string } } = {
		locals: { session: { kind: 'signed-in', user } },
		url,
		request: new Request(url),
		params: { id }
	};
	return partial as Parameters<typeof load>[0];
}

async function refusal(user: ConsoleUser, id: string): Promise<unknown> {
	return Promise.resolve()
		.then(() => load(opening(user, id)))
		.catch((error: unknown) => error);
}

describe('the pop-out window load (PO8)', () => {
	it('PO8: gives the machine and grants to a person with desktop-view', async () => {
		const { member, machineId } = await memberWith(['view', 'desktop-view']);
		expect(await load(opening(member, machineId))).toMatchObject({
			machine: { id: machineId },
			grants: [
				{ permission: 'view', consent: 'unattended' },
				{ permission: 'desktop-view', consent: 'unattended' }
			]
		});
	});

	it('PO8: an admin may open any machine', async () => {
		const { admin, machineId } = await memberWith([]);
		expect(await load(opening(admin, machineId))).toMatchObject({ machine: { id: machineId } });
	});

	it('PO8: refuses a person who may see the machine but not its screen with 403', async () => {
		const { member, machineId } = await memberWith(['view', 'terminal']);
		expect(isHttpError(await refusal(member, machineId), 403)).toBe(true);
	});

	it('PO8: answers 404 for a machine the person cannot see, as if it were missing', async () => {
		const { member, machineId } = await memberWith([]);
		expect(isHttpError(await refusal(member, machineId), 404)).toBe(true);
		expect(isHttpError(await refusal(member, crypto.randomUUID()), 404)).toBe(true);
	});
});

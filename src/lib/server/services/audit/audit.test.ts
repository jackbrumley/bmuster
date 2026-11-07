import { describe, expect, it } from 'vitest';
import { enrolFakeAgent, testDatabase } from '#tests/helpers/fake-agent.ts';
import { addTestUser, CLIENT, NOW, PASSWORD } from '#tests/helpers/people.ts';
import { addProvider, deleteProvider, updateProvider } from '../auth/identity-providers.ts';
import { signInWithPassword } from '../auth/password-sign-in.ts';
import { signOut } from '../auth/sessions.ts';
import { updateSetting } from '../settings/settings.ts';
import { activityFeed } from '../users/activity-feed.ts';
import { addNote, deleteNote, editNote } from '../machines/machine-notes.ts';
import { updateMachineDetails } from '../machines/machine-details.ts';
import { addUser, disableUser, setRole, toConsoleUser } from '../users/users.ts';
import { listAudit } from './audit.ts';

const KEY = Buffer.alloc(32, 5);

describe('audit log (S13)', () => {
	it('records sign-ins, failures, sign-outs and changes to users and providers', async () => {
		const database = testDatabase();
		const admin = await addTestUser(database, {
			email: 'jack@example.com',
			role: 'admin',
			password: PASSWORD
		});
		const failed = await signInWithPassword(
			database,
			{ email: 'jack@example.com', password: 'wrong wrong wrong' },
			CLIENT,
			NOW
		);
		expect(failed.kind).toBe('refused');
		const signedIn = await signInWithPassword(
			database,
			{ email: 'jack@example.com', password: PASSWORD },
			CLIENT,
			NOW + 1
		);
		if (signedIn.kind !== 'signed-in') throw new Error('sign-in refused');
		const added = await addUser(
			database,
			admin.id,
			{ name: 'Priya', email: 'priya@example.com', role: 'member', password: null },
			NOW + 2
		);
		if (added.kind !== 'done') throw new Error(added.message);
		setRole(database, admin.id, added.user.id, 'admin', NOW + 3);
		disableUser(database, admin.id, added.user.id, NOW + 4);
		const provider = addProvider(
			database,
			admin.id,
			{
				name: 'Authentik',
				kind: 'authentik',
				issuer: 'https://auth.example/application/o/b/',
				clientId: 'c',
				clientSecret: 's',
				scopes: ['openid'],
				newPeople: 'invited',
				enabled: true
			},
			KEY,
			NOW + 5
		);
		updateProvider(
			database,
			admin.id,
			provider.id,
			{
				name: 'Authentik',
				kind: 'authentik',
				issuer: 'https://auth.example/application/o/b/',
				clientId: 'c',
				clientSecret: { kind: 'keep' },
				scopes: ['openid'],
				newPeople: 'auto-create',
				enabled: true
			},
			KEY,
			NOW + 6
		);
		deleteProvider(database, admin.id, provider.id, NOW + 7);
		signOut(database, signedIn.session.token, admin.id, admin.email, NOW + 8);

		expect(listAudit(database, 50).map((entry) => entry.kind)).toEqual([
			'sign-out',
			'provider-deleted',
			'provider-changed',
			'provider-added',
			'user-disabled',
			'user-role-changed',
			'user-added',
			'sign-in',
			'sign-in-failed'
		]);
		expect(listAudit(database, 50).at(-1)).toMatchObject({
			target: 'jack@example.com',
			detail: { method: 'password', reason: 'wrong-password', ip: CLIENT.ip }
		});
	});

	it('shows entries on the Activity page with who did them, newest first', async () => {
		const database = testDatabase();
		await addTestUser(database, { email: 'jack@example.com', role: 'admin', password: PASSWORD });
		await signInWithPassword(
			database,
			{ email: 'nobody@example.com', password: 'wrong wrong wrong' },
			CLIENT,
			NOW
		);
		await signInWithPassword(
			database,
			{ email: 'jack@example.com', password: PASSWORD },
			CLIENT,
			NOW + 1
		);
		const feed = activityFeed(database, 10);
		expect(feed.map((entry) => [entry.kind, entry.actor])).toEqual([
			['sign-in', { kind: 'user', name: 'jack' }],
			['sign-in-failed', { kind: 'system' }]
		]);
		expect(feed[0]?.detail).toContainEqual({ label: 'method', value: 'password' });
	});

	it('L8: turning local network mode on and off is audited', async () => {
		const database = testDatabase();
		const admin = await addTestUser(database, {
			email: 'jack@example.com',
			role: 'admin',
			password: null
		});
		updateSetting(database, admin.id, 'localNetworkMode', true, NOW);
		updateSetting(database, admin.id, 'localNetworkMode', false, NOW + 1);
		expect(listAudit(database, 10)).toEqual([
			expect.objectContaining({
				kind: 'setting-changed',
				actorUserId: admin.id,
				target: 'Local network mode',
				detail: { from: 'true', to: 'false' }
			}),
			expect.objectContaining({
				kind: 'setting-changed',
				actorUserId: admin.id,
				target: 'Local network mode',
				detail: { from: 'false', to: 'true' }
			})
		]);
	});
});

describe('machine details in the audit log (D5)', () => {
	it('records renames, description changes and note deletions with who did them', async () => {
		const database = testDatabase();
		const admin = toConsoleUser(
			await addTestUser(database, { email: 'ada@example.com', role: 'admin', password: null })
		);
		const { machineId } = enrolFakeAgent(database, NOW);
		updateMachineDetails(
			database,
			machineId,
			{ name: 'Reception PC', description: '' },
			admin.id,
			NOW + 1
		);
		updateMachineDetails(
			database,
			machineId,
			{ name: 'Reception PC', description: 'Front desk' },
			admin.id,
			NOW + 2
		);
		// Saving the same values again records nothing.
		updateMachineDetails(
			database,
			machineId,
			{ name: 'Reception PC', description: 'Front desk' },
			admin.id,
			NOW + 3
		);
		const note = addNote(database, machineId, admin, 'Spare key in the top drawer', NOW + 4);
		if (note === undefined) throw new Error('note not added');
		// Adding and editing notes are not audited; deleting is.
		editNote(database, machineId, note.id, admin, 'Spare key in the second drawer', NOW + 5);
		deleteNote(database, machineId, note.id, admin, NOW + 6);

		expect(listAudit(database, 10)).toMatchObject([
			{
				actorUserId: admin.id,
				kind: 'machine-note-deleted',
				target: 'Reception PC',
				detail: { author: 'ada', note: 'Spare key in the second drawer' }
			},
			{
				actorUserId: admin.id,
				kind: 'machine-description-changed',
				target: 'Reception PC',
				detail: { description: 'Front desk' }
			},
			{
				actorUserId: admin.id,
				kind: 'machine-renamed',
				target: 'Reception PC',
				detail: { from: 'Test machine' }
			},
			{ kind: 'machine-enrolled' }
		]);
		expect(activityFeed(database, 1)[0]).toMatchObject({
			kind: 'machine-note-deleted',
			actor: { kind: 'user', name: 'ada' }
		});
	});
});

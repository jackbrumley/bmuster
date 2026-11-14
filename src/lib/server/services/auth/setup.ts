import type { ConsoleUser } from '#lib/domain/users/user.ts';
import { firstAdminSchema } from '#lib/schemas/auth/sign-in.ts';
import type { AppDatabase } from '../../database/connection.ts';
import type { FirstAdmin } from '../../env.ts';
import { recordAudit } from '../audit/audit.ts';
import { getSetting, updateSettingAsSystem } from '../settings/settings.ts';
import { hasUsers, insertUser, markSignedIn, toConsoleUser } from '../users/users.ts';
import type { SignInClient } from './client.ts';
import { hashPassword } from './passwords.ts';
import type { SetupCodeKeeper } from './setup-code.ts';
import { startSession, type StartedSession } from './sessions.ts';

/**
 * First run (SPEC-SIGN-IN S1, S17): while there are no users, /setup makes
 * the first admin and signs them in, once the person has typed the setup code
 * from the server's log. The check and the insert share one transaction, so
 * two people racing for /setup cannot both become admin.
 */
export type SetupResult =
	| { kind: 'created'; user: ConsoleUser; session: StartedSession }
	| { kind: 'wrong-code'; message: string }
	| { kind: 'closed' };

export async function setupFirstAdmin(
	database: AppDatabase,
	input: { setupCode: string; name: string; email: string; password: string },
	setupCode: SetupCodeKeeper,
	client: SignInClient,
	now: number
): Promise<SetupResult> {
	if (hasUsers(database)) {
		return { kind: 'closed' };
	}
	const code = setupCode.check(input.setupCode);
	if (code.kind === 'wrong') {
		return { kind: 'wrong-code', message: code.message };
	}
	const passwordHash = await hashPassword(input.password);
	return database.transaction((transaction): SetupResult => {
		if (hasUsers(transaction)) {
			return { kind: 'closed' };
		}
		const user = insertUser(
			transaction,
			{ name: input.name, email: input.email, role: 'admin', passwordHash },
			now
		);
		markSignedIn(transaction, user.id, now);
		recordAudit(
			transaction,
			{
				actor: { kind: 'user', userId: user.id },
				kind: 'setup',
				target: user.email,
				machineId: null,
				detail: { ip: client.ip }
			},
			now
		);
		const session = startSession(transaction, user.id, client, now);
		setupCode.clear();
		return { kind: 'created', user: toConsoleUser(user), session };
	});
}

/**
 * Start-up (S17, S18). With BMUSTER_ADMIN_EMAIL and _PASSWORD set and no
 * users, that admin is created and /setup is skipped; the variables never
 * touch an existing account. With no users after that, a setup code is
 * printed. Bad variables stop the server (fail hard).
 */
export async function prepareFirstRun(
	database: AppDatabase,
	firstAdmin: FirstAdmin,
	setupCode: SetupCodeKeeper,
	print: (line: string) => void,
	now: number
): Promise<void> {
	if (firstAdmin.kind === 'set') {
		const created = await createAdminFromEnvironment(database, firstAdmin, now);
		print(
			created
				? `BMuster: created the admin ${firstAdmin.email.toLowerCase()} from BMUSTER_ADMIN_EMAIL and BMUSTER_ADMIN_PASSWORD. Remove these variables now; they are not needed again.`
				: 'BMuster: BMUSTER_ADMIN_EMAIL and BMUSTER_ADMIN_PASSWORD are set, but this server already has users, so they were ignored. Remove these variables.'
		);
	}
	if (!hasUsers(database)) {
		setupCode.ensureIssued();
	}
}

/**
 * Start-up, before the listener is chosen (SPEC-SERVER-INSTALL I12): with
 * BMUSTER_LOCAL_NETWORK_MODE=on and no users yet, local network mode is
 * turned on, so a fresh install with no domain serves HTTPS. Once someone has
 * set the server up, Settings owns the setting and the variable does nothing.
 */
export function applyFirstRunLocalNetworkMode(
	database: AppDatabase,
	wanted: boolean,
	now: number
): void {
	if (!wanted || hasUsers(database) || getSetting(database, 'localNetworkMode')) {
		return;
	}
	database.transaction((transaction) => {
		updateSettingAsSystem(transaction, 'localNetworkMode', true, 'BMUSTER_LOCAL_NETWORK_MODE', now);
	});
}

/** True when the admin was created; false when the server already had users. */
async function createAdminFromEnvironment(
	database: AppDatabase,
	firstAdmin: { name: string; email: string; password: string },
	now: number
): Promise<boolean> {
	if (hasUsers(database)) {
		return false;
	}
	const parsed = firstAdminSchema.safeParse(firstAdmin);
	if (!parsed.success) {
		const issue = parsed.error.issues[0];
		throw new Error(
			`BMUSTER_ADMIN_${String(issue?.path[0] ?? '').toUpperCase()}: ${issue?.message ?? 'not valid'}`
		);
	}
	const passwordHash = await hashPassword(parsed.data.password);
	return database.transaction((transaction) => {
		if (hasUsers(transaction)) {
			return false;
		}
		const user = insertUser(
			transaction,
			{ name: parsed.data.name, email: parsed.data.email, role: 'admin', passwordHash },
			now
		);
		recordAudit(
			transaction,
			{
				actor: { kind: 'system' },
				kind: 'setup',
				target: user.email,
				machineId: null,
				detail: { source: 'BMUSTER_ADMIN_EMAIL and BMUSTER_ADMIN_PASSWORD' }
			},
			now
		);
		return true;
	});
}

/** People who sign in to the console. Browser-safe. */

/** Console-wide role. Admins manage users, groups, rules, settings and enrolment. */
export type ConsoleRole = 'admin' | 'member';

export const CONSOLE_ROLES: readonly ConsoleRole[] = ['admin', 'member'];

export function roleLabel(role: ConsoleRole): string {
	switch (role) {
		case 'admin':
			return 'Admin';
		case 'member':
			return 'Member';
	}
}

/** The signed-in person, as the console frame and the guards see them. */
export type ConsoleUser = {
	id: string;
	name: string;
	email: string;
	role: ConsoleRole;
};

/** One row of the Users page. */
export type UserView = {
	id: string;
	name: string;
	email: string;
	role: ConsoleRole;
	status: { kind: 'active' } | { kind: 'disabled'; disabledIso: string };
	hasPassword: boolean;
	/**
	 * Names of the providers this person has signed in with. While there are
	 * any, the email belongs to the provider and is not edited here.
	 */
	providerNames: string[];
	lastSignIn: { kind: 'never' } | { kind: 'at'; iso: string };
	createdIso: string;
};

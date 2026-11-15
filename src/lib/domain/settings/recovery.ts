/**
 * What an admin needs to get this server back after a lost disk, a lost password or a lost
 * authenticator (SPEC-SERVER-INSTALL I17): where its secrets key and snapshots are, and the
 * host commands for this deployment. Browser-safe; the server fills it in.
 */
export type RecoveryFacts = {
	deployment: 'linux' | 'windows' | 'docker' | 'source';
	/** Where SECRETS_KEY lives. */
	secrets:
		| { kind: 'settings-file'; path: string }
		| { kind: 'container-variable' }
		| { kind: 'dotenv-or-environment' };
	snapshots: { kind: 'daily'; folder: string; keep: number } | { kind: 'off'; folder: string };
	/** The two commands, ready to paste on the server's machine, for the signed-in admin. */
	commands: { resetPassword: string; resetTwoFactor: string };
};

export const RECOVERY_FAQ_URL = 'https://bmuster.com/faq#getting-back-in';

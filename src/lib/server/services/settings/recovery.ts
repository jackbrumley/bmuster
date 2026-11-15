import { posix, win32 } from 'node:path';
import type { RecoveryFacts } from '#lib/domain/settings/recovery.ts';
import { snapshotFolderFor, type SnapshotSchedule } from '../../database/snapshots.ts';
import type { LauncherConfig } from '../../env.ts';

/**
 * The Recovery panel's facts for this server (SPEC-SERVER-INSTALL I17), from how it was started:
 * the installed launcher, the container image, or a source checkout. The commands are those of
 * docs/hosting.md section 7, filled in for this server's folders and the admin reading them.
 */
export type RecoveryInput = {
	launcher: LauncherConfig;
	databasePath: string;
	releasesPath: string;
	backupSchedule: SnapshotSchedule;
	email: string;
};

const DEFAULT_LINUX_DATA = '/var/lib/bmuster-server';
const DEFAULT_WINDOWS_DATA = 'C:\\ProgramData\\BMuster Server';

/** A word for a POSIX shell: as it is when it is safe, else in single quotes. */
function posixWord(text: string): string {
	return /^[\w@%+=:,./-]+$/.test(text) ? text : `'${text.replaceAll("'", "'\\''")}'`;
}

/** A word for PowerShell: as it is when it is safe, else in single quotes. */
function powerShellWord(text: string): string {
	return /^[\w@%+=:,./\\-]+$/.test(text) ? text : `'${text.replaceAll("'", "''")}'`;
}

/**
 * The program folder of an installed release: the launcher sets RELEASES_PATH to
 * `<program>/releases/<version>/releases`.
 */
function programFolder(releasesPath: string, path: typeof posix): string {
	const release = path.dirname(releasesPath);
	const releases = path.dirname(release);
	if (path.basename(releasesPath) !== 'releases' || path.basename(releases) !== 'releases') {
		throw new Error(`RELEASES_PATH ${releasesPath} is not inside an installed release`);
	}
	return path.dirname(releases);
}

function snapshots(
	schedule: SnapshotSchedule,
	databasePath: string,
	path: typeof posix
): RecoveryFacts['snapshots'] {
	const folder =
		path === win32
			? win32.join(win32.dirname(databasePath), 'backups')
			: snapshotFolderFor(databasePath);
	switch (schedule.kind) {
		case 'off':
			return { kind: 'off', folder };
		case 'daily':
			return { kind: 'daily', folder, keep: schedule.keep };
	}
}

export function recoveryFacts(input: RecoveryInput): RecoveryFacts {
	const { launcher, email } = input;
	switch (launcher.kind) {
		case 'installed': {
			const windows = launcher.target === 'x86_64-pc-windows-msvc';
			const path = windows ? win32 : posix;
			const program = programFolder(input.releasesPath, path);
			const command = (action: string): string => {
				if (windows) {
					const launcherPath = win32.join(program, 'current', 'bmuster-server.exe');
					const dataDir =
						launcher.dataDir.toLowerCase() === DEFAULT_WINDOWS_DATA.toLowerCase()
							? ''
							: ` --data-dir ${powerShellWord(launcher.dataDir)}`;
					return `& "${launcherPath}" ${action}${dataDir} --email ${powerShellWord(email)}`;
				}
				const launcherPath = posix.join(program, 'current', 'bmuster-server');
				const dataDir =
					launcher.dataDir === DEFAULT_LINUX_DATA
						? ''
						: ` --data-dir ${posixWord(launcher.dataDir)}`;
				return `sudo ${posixWord(launcherPath)} ${action}${dataDir} --email ${posixWord(email)}`;
			};
			return {
				deployment: windows ? 'windows' : 'linux',
				secrets: { kind: 'settings-file', path: path.join(launcher.dataDir, 'server.env') },
				snapshots: snapshots(input.backupSchedule, input.databasePath, path),
				commands: {
					resetPassword: command('reset-password'),
					resetTwoFactor: command('reset-two-factor')
				}
			};
		}
		case 'docker':
			return {
				deployment: 'docker',
				secrets: { kind: 'container-variable' },
				snapshots: snapshots(input.backupSchedule, input.databasePath, posix),
				commands: {
					resetPassword: `docker exec <container> bmuster-server reset-password --email ${posixWord(email)}`,
					resetTwoFactor: `docker exec <container> bmuster-server reset-two-factor --email ${posixWord(email)}`
				}
			};
		case 'source':
			return {
				deployment: 'source',
				secrets: { kind: 'dotenv-or-environment' },
				snapshots: snapshots(input.backupSchedule, input.databasePath, posix),
				commands: {
					resetPassword: `npm run admin:reset -- --email ${posixWord(email)}`,
					resetTwoFactor: `npm run two-factor:reset -- --email ${posixWord(email)}`
				}
			};
	}
}

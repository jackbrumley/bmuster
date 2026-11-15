import { describe, expect, it } from 'vitest';
import { recoveryFacts } from './recovery.ts';

const NONCE = 'a'.repeat(64);
const DAILY = { kind: 'daily', hour: 3, minute: 0, keep: 14 } as const;

describe('the Recovery panel facts (SPEC-SERVER-INSTALL I17)', () => {
	it('I17: an installed Linux server: server.env and backups in its data folder, and its two commands', () => {
		expect(
			recoveryFacts({
				launcher: {
					kind: 'installed',
					dataDir: '/var/lib/bmuster-server',
					target: 'x86_64-unknown-linux-gnu',
					nonce: NONCE
				},
				databasePath: '/var/lib/bmuster-server/bmuster.db',
				releasesPath: '/opt/bmuster-server/releases/0.4.35/releases',
				backupSchedule: DAILY,
				email: 'ada@example.com'
			})
		).toEqual({
			deployment: 'linux',
			secrets: { kind: 'settings-file', path: '/var/lib/bmuster-server/server.env' },
			snapshots: { kind: 'daily', folder: '/var/lib/bmuster-server/backups', keep: 14 },
			commands: {
				resetPassword:
					'sudo /opt/bmuster-server/current/bmuster-server reset-password --email ada@example.com',
				resetTwoFactor:
					'sudo /opt/bmuster-server/current/bmuster-server reset-two-factor --email ada@example.com'
			}
		});
	});

	it('I17: a Linux server installed in other folders names them in its commands', () => {
		const facts = recoveryFacts({
			launcher: {
				kind: 'installed',
				dataDir: '/srv/bmuster data',
				target: 'aarch64-unknown-linux-gnu',
				nonce: NONCE
			},
			databasePath: '/srv/bmuster data/bmuster.db',
			releasesPath: '/srv/bmuster/releases/0.4.35/releases',
			backupSchedule: { kind: 'off' },
			email: 'ada@example.com'
		});
		expect(facts.commands.resetPassword).toBe(
			"sudo /srv/bmuster/current/bmuster-server reset-password --data-dir '/srv/bmuster data' --email ada@example.com"
		);
		expect(facts.snapshots).toEqual({ kind: 'off', folder: '/srv/bmuster data/backups' });
	});

	it('I17: an installed Windows server: PowerShell commands and Windows paths', () => {
		expect(
			recoveryFacts({
				launcher: {
					kind: 'installed',
					dataDir: 'C:\\ProgramData\\BMuster Server',
					target: 'x86_64-pc-windows-msvc',
					nonce: NONCE
				},
				databasePath: 'C:\\ProgramData\\BMuster Server\\bmuster.db',
				releasesPath: 'C:\\Program Files\\BMuster Server\\releases\\0.4.35\\releases',
				backupSchedule: DAILY,
				email: 'ada@example.com'
			})
		).toEqual({
			deployment: 'windows',
			secrets: { kind: 'settings-file', path: 'C:\\ProgramData\\BMuster Server\\server.env' },
			snapshots: { kind: 'daily', folder: 'C:\\ProgramData\\BMuster Server\\backups', keep: 14 },
			commands: {
				resetPassword:
					'& "C:\\Program Files\\BMuster Server\\current\\bmuster-server.exe" reset-password --email ada@example.com',
				resetTwoFactor:
					'& "C:\\Program Files\\BMuster Server\\current\\bmuster-server.exe" reset-two-factor --email ada@example.com'
			}
		});
	});

	it('I17: the container image: the key is a container variable, the commands go through docker exec', () => {
		expect(
			recoveryFacts({
				launcher: { kind: 'docker' },
				databasePath: '/data/bmuster.db',
				releasesPath: '/app/releases',
				backupSchedule: { kind: 'daily', hour: 0, minute: 30, keep: 7 },
				email: 'ada@example.com'
			})
		).toEqual({
			deployment: 'docker',
			secrets: { kind: 'container-variable' },
			snapshots: { kind: 'daily', folder: '/data/backups', keep: 7 },
			commands: {
				resetPassword:
					'docker exec <container> bmuster-server reset-password --email ada@example.com',
				resetTwoFactor:
					'docker exec <container> bmuster-server reset-two-factor --email ada@example.com'
			}
		});
	});

	it('I17: a server run from source uses the npm scripts', () => {
		const facts = recoveryFacts({
			launcher: { kind: 'source' },
			databasePath: './data/bmuster.db',
			releasesPath: './data/releases',
			backupSchedule: DAILY,
			email: "o'neil@example.com"
		});
		expect(facts.deployment).toBe('source');
		expect(facts.secrets).toEqual({ kind: 'dotenv-or-environment' });
		expect(facts.commands).toEqual({
			resetPassword: "npm run admin:reset -- --email 'o'\\''neil@example.com'",
			resetTwoFactor: "npm run two-factor:reset -- --email 'o'\\''neil@example.com'"
		});
	});
});

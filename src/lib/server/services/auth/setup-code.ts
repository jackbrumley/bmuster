import { createHash, timingSafeEqual } from 'node:crypto';
import { groupCode, normaliseCode, randomCode } from '../../crypto/random-code.ts';

/**
 * The first-run setup code (SPEC-SIGN-IN S17). While the server has no users,
 * /setup asks for a one-time code the server printed to its own log, so
 * whoever reaches a fresh server first over the network cannot make
 * themselves its admin. Only the code's hash is kept, in memory: a restart
 * prints a new code until setup is done. After `SETUP_CODE_TRIES` wrong codes
 * the code is replaced (and the new one printed), so guessing gets nowhere
 * without the log.
 */
export const SETUP_CODE_TRIES = 5;

type SetupCodeCheck = { kind: 'right' } | { kind: 'wrong'; message: string };

export type SetupCodeKeeper = {
	/** Prints a code unless one is already waiting. */
	ensureIssued(): void;
	check(typed: string): SetupCodeCheck;
	/** Setup is done: the code is no longer accepted. */
	clear(): void;
};

type Held = { kind: 'none' } | { kind: 'held'; hash: Buffer; wrongTries: number };

function hash(raw: string): Buffer {
	return createHash('sha256').update(raw, 'utf8').digest();
}

export function setupCodeKeeper(print: (line: string) => void): SetupCodeKeeper {
	let held: Held = { kind: 'none' };

	function issue(): void {
		const raw = randomCode(16);
		held = { kind: 'held', hash: hash(raw), wrongTries: 0 };
		const rule = '='.repeat(72);
		print(
			`${rule}\nBMuster first-run setup code: ${groupCode(raw, 4)} — open /setup\n` +
				`It is needed once, to create the first admin. A restart prints a new code.\n${rule}`
		);
	}

	return {
		ensureIssued() {
			if (held.kind === 'none') {
				issue();
			}
		},
		check(typed) {
			if (held.kind === 'none') {
				issue();
				return {
					kind: 'wrong',
					message: 'The server has just printed a new setup code to its log. Enter that one.'
				};
			}
			if (timingSafeEqual(hash(normaliseCode(typed)), held.hash)) {
				return { kind: 'right' };
			}
			held.wrongTries += 1;
			if (held.wrongTries >= SETUP_CODE_TRIES) {
				issue();
				return {
					kind: 'wrong',
					message:
						'Too many wrong setup codes. The server has printed a new code to its log; enter that one.'
				};
			}
			return {
				kind: 'wrong',
				message: 'That setup code is not right. It is in the server log, where BMuster was started.'
			};
		},
		clear() {
			held = { kind: 'none' };
		}
	};
}

/**
 * The setup code in the server's log: its standard output (the terminal, journald or Docker),
 * never the stored server log (SPEC-AGENT-LOGS 2), because the code is a secret.
 */
function printToServerLog(line: string): void {
	process.stdout.write(`${line}\n`);
}

/** The running server's keeper. */
export const serverSetupCode = setupCodeKeeper(printToServerLog);

import type { ActivityEntry, AuditKind } from './activity.ts';

/**
 * How Activity words what happened on a machine's local page (SPEC-AGENT-LOCAL 7), and a
 * machine going offline and coming back (SPEC-PRESENCE). The agent
 * reports the events; the server stores whose code was used (`whose`), when it received them
 * (`sentIso`) and any extras in the entry's detail. Browser-safe.
 */

/** "Jack Brumley's code", or the shared machine code an older agent still takes. */
export function whoseCode(
	codes: { kind: 'machine' } | { kind: 'people'; names: readonly string[] }
): string {
	switch (codes.kind) {
		case 'machine':
			return 'the shared machine code';
		case 'people':
			if (codes.names.length === 1) {
				return `${codes.names.join('')}'s code`;
			}
			// Several only when their codes matched in the same 30 seconds.
			return `${codes.names.join(' and ')}'s codes (they matched at once)`;
	}
}

const LOCAL_PAGE_KINDS = [
	'local-signed-in',
	'local-signed-out',
	'local-session-expired',
	'local-wrong-code',
	'local-locked-out',
	'local-restarted',
	'local-connection-tested',
	'local-move-started',
	'local-move-finished',
	'local-move-failed',
	'local-leaving',
	'local-uninstalled',
	'local-events-dropped'
] as const satisfies readonly AuditKind[];

type LocalPageKind = (typeof LOCAL_PAGE_KINDS)[number];

function isLocalPageKind(kind: AuditKind): kind is LocalPageKind {
	return LOCAL_PAGE_KINDS.some((local) => local === kind);
}

export type ActivitySentence =
	| { kind: 'standard' }
	| { kind: 'local'; text: string; warning: boolean; sentIso: string }
	| { kind: 'presence'; text: string; warning: boolean };

function detailValue(entry: ActivityEntry, label: string): string {
	return entry.detail.find((item) => item.label === label)?.value ?? '';
}

function capitalised(text: string): string {
	return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * The sentence for a local page entry, or for a machine going offline and coming back
 * (SPEC-PRESENCE P6: "mint went offline"); `standard` for every other entry.
 */
export function activitySentence(entry: ActivityEntry): ActivitySentence {
	const kind = entry.kind;
	if (kind === 'machine-offline') {
		return { kind: 'presence', text: `${entry.target} went offline`, warning: true };
	}
	if (kind === 'machine-online') {
		return { kind: 'presence', text: `${entry.target} came back online`, warning: false };
	}
	if (!isLocalPageKind(kind)) {
		return { kind: 'standard' };
	}
	const machine = entry.target;
	const whose = detailValue(entry, 'whose');
	const by = `(signed in with ${whose})`;
	const local = (text: string, warning: boolean): ActivitySentence => ({
		kind: 'local',
		text,
		warning,
		sentIso: detailValue(entry, 'sentIso')
	});
	switch (kind) {
		case 'local-signed-in':
			return local(`${capitalised(whose)} signed in to the local page on ${machine}`, false);
		case 'local-signed-out':
			return local(`Signed out of the local page on ${machine} ${by}`, false);
		case 'local-session-expired':
			return local(`A local page session on ${machine} ended ${by}`, false);
		case 'local-wrong-code':
			return local(`A wrong code was entered on the local page on ${machine}`, true);
		case 'local-locked-out':
			return local(
				`Sign-in to the local page on ${machine} paused for 5 minutes after 5 wrong codes`,
				true
			);
		case 'local-restarted':
			return local(`Restarted the agent from the local page on ${machine} ${by}`, false);
		case 'local-connection-tested': {
			const result = detailValue(entry, 'passed') === 'yes' ? 'passed' : 'failed';
			return local(
				`Tested the connection from the local page on ${machine}: ${result} ${by}`,
				result === 'failed'
			);
		}
		case 'local-move-started':
			return local(
				`Started moving ${machine} to ${detailValue(entry, 'server')} from the local page ${by}`,
				false
			);
		case 'local-move-finished':
			return local(
				`Moved ${machine} to ${detailValue(entry, 'server')} from the local page ${by}`,
				false
			);
		case 'local-move-failed':
			return local(
				`Moving ${machine} to another server from the local page failed: ${detailValue(entry, 'reason')} ${by}`,
				true
			);
		case 'local-leaving': {
			const why = detailValue(entry, 'reason') === 'moved' ? 'it moved' : 'it is being uninstalled';
			return local(
				`The agent on ${machine} told this server it is leaving, because ${why}, from the local page ${by}`,
				false
			);
		}
		case 'local-uninstalled':
			return local(`Uninstalled the agent on ${machine} from the local page ${by}`, false);
		case 'local-events-dropped':
			return local(
				`${detailValue(entry, 'count')} older local page events on ${machine} were lost: the agent was offline and its queue was full`,
				true
			);
	}
}

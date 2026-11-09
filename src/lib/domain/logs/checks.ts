/**
 * Self-checks and session timelines as the console and diagnostics readers see them
 * (SPEC-DIAGNOSTICS). The agent side is agent/crates/protocol/src/checks.rs.
 */

export const CHECK_STATUSES = ['pass', 'fail', 'not-applicable'] as const;
type CheckStatus = (typeof CHECK_STATUSES)[number];

/** A check's detail is at most 2 KiB. */
export const MAX_CHECK_DETAIL = 2048;
/** At most this many results in one report. */
export const MAX_CHECKS = 32;
/** Run checks: at most once a minute per machine. */
export const RUN_CHECKS_EVERY_MS = 60_000;
/** The log record targets that carry timelines and desktop figures. */
export const TIMELINE_TARGET = 'session-timeline';
export const STATS_TARGET = 'session-stats';

export type CheckResultView = {
	id: string;
	title: string;
	status: CheckStatus;
	detail: string;
	durationMs: number;
	checkedAtIso: string;
};

/**
 * - `unreported`: the agent is older than 0.4.3 and runs no checks.
 * - `pending`: the agent started and has not finished its first run (a minute after start).
 */
export type MachineChecks =
	| { kind: 'unreported' }
	| { kind: 'pending'; receivedIso: string }
	| { kind: 'results'; receivedIso: string; results: CheckResultView[] };

export type TimelineStepView = { t: number; step: string; detail: string };

export type SessionTimelineView = {
	outcome: 'ended' | 'failed';
	reason: string;
	startedIso: string;
	steps: TimelineStepView[];
	omitted: number;
};

export type SessionStatsView = {
	atIso: string;
	intervalMs: number;
	framesSent: number;
	captureMsAvg: number;
	encodeMsAvg: number;
	bytesPerSecond: number;
	droppedFrames: number;
	tiles: number;
	backend: string;
};

/**
 * One session on the machine, from the server's own audit entries (who, when, how it ended) and
 * the agent's timeline and figures, joined by the session id. Either side can be missing: an
 * entry from before 0.4.3 has no session id, and an older agent ships no timeline.
 */
export type MachineSessionView = {
	sessionId: string;
	kind: string;
	startedIso: string;
	server:
		| { kind: 'unknown' }
		| {
				kind: 'known';
				userName: string;
				openedIso: string;
				ended: { kind: 'running' } | { kind: 'ended'; endedIso: string; how: string };
		  };
	timeline: { kind: 'none' } | ({ kind: 'shipped' } & SessionTimelineView);
	/** Newest first, at most the last ten intervals. */
	stats: SessionStatsView[];
};

/** A failed check's line for the command line and Copy: "FAIL terminal-pty: reason". */
export function checkLine(result: CheckResultView): string {
	const status = result.status === 'not-applicable' ? 'N/A' : result.status.toUpperCase();
	return `${status.padEnd(4)} ${result.id} (${result.durationMs} ms): ${result.detail}`;
}

/** A step as text: "+120 ms unit-started bmuster-terminal-1.service". */
export function stepLine(step: TimelineStepView): string {
	return `+${step.t} ms ${step.step}${step.detail === '' ? '' : ` ${step.detail}`}`;
}

/** A desktop interval in a few words. */
export function statsLine(stats: SessionStatsView): string {
	const seconds = Math.max(1, Math.round(stats.intervalMs / 1000));
	return `${stats.backend}: ${stats.framesSent} frames in ${seconds} s, capture ${stats.captureMsAvg.toFixed(1)} ms, encode ${stats.encodeMsAvg.toFixed(1)} ms, ${Math.round(stats.bytesPerSecond / 1024)} KiB/s, ${stats.droppedFrames} dropped, ${stats.tiles} tiles`;
}

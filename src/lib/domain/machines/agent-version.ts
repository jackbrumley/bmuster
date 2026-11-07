/**
 * Agent versions (SPEC-AGENT-UPDATES): `1.2.3` for releases and
 * `1.2.3-dev.20261107153000` for development builds, compared by Semantic
 * Versioning precedence, the same rules as the agent's AgentVersion
 * (agent/crates/protocol/src/updates.rs). Browser-safe.
 */

const NUMBER = '(?:0|[1-9]\\d*)';
const IDENTIFIER = '(?:0|[1-9]\\d*|\\d*[A-Za-z-][0-9A-Za-z-]*)';
const VERSION = new RegExp(
	`^(${NUMBER})\\.(${NUMBER})\\.(${NUMBER})(?:-(${IDENTIFIER}(?:\\.${IDENTIFIER})*))?$`
);

/** Also what a release folder may be called, so a version can never be a path. */
export function isAgentVersion(text: string): boolean {
	return VERSION.test(text);
}

type Parsed = { core: [number, number, number]; pre: string[] };

function parse(text: string): Parsed {
	const match = VERSION.exec(text);
	if (match === null) {
		throw new Error(`${text} is not an agent version`);
	}
	return {
		core: [Number(match[1]), Number(match[2]), Number(match[3])],
		pre: match[4] === undefined ? [] : match[4].split('.')
	};
}

function compareIdentifiers(left: string, right: string): number {
	const leftNumber = /^\d+$/.test(left);
	const rightNumber = /^\d+$/.test(right);
	if (leftNumber && rightNumber) {
		return Math.sign(Number(left) - Number(right));
	}
	if (leftNumber !== rightNumber) {
		return leftNumber ? -1 : 1;
	}
	return left < right ? -1 : left > right ? 1 : 0;
}

/** Negative when `a` is older than `b`, positive when newer, 0 when the same. */
export function compareAgentVersions(a: string, b: string): number {
	const left = parse(a);
	const right = parse(b);
	for (let index = 0; index < 3; index += 1) {
		const difference = (left.core[index] ?? 0) - (right.core[index] ?? 0);
		if (difference !== 0) {
			return Math.sign(difference);
		}
	}
	if (left.pre.length === 0 || right.pre.length === 0) {
		return Math.sign(right.pre.length - left.pre.length);
	}
	const shared = Math.min(left.pre.length, right.pre.length);
	for (let index = 0; index < shared; index += 1) {
		const order = compareIdentifiers(left.pre[index] ?? '', right.pre[index] ?? '');
		if (order !== 0) {
			return order;
		}
	}
	return Math.sign(left.pre.length - right.pre.length);
}

/** True when `version` is older than `than`; an unreadable version counts as older. */
export function isOlderAgent(version: string, than: string): boolean {
	return !isAgentVersion(version) || compareAgentVersions(version, than) < 0;
}

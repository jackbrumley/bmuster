/**
 * Agent builds the server offers (SPEC-ENROLMENT 6.1, 12) and the manual
 * install (SPEC-INSTALL-OPTIONS M1–M4). Browser-safe.
 */
export const AGENT_TARGETS = [
	'x86_64-unknown-linux-gnu',
	'aarch64-unknown-linux-gnu',
	'x86_64-pc-windows-msvc'
] as const;

export type AgentTarget = (typeof AGENT_TARGETS)[number];

export function isAgentTarget(value: string): value is AgentTarget {
	return AGENT_TARGETS.some((target) => target === value);
}

/** The newest build for one target, as Add machine offers it. */
export type AgentDownload =
	| { kind: 'none'; target: AgentTarget }
	| { kind: 'ready'; target: AgentTarget; version: string; size: number; sha256: string };

/** The command to run beside a downloaded agent, with the server and join code filled in. */
export function manualInstallCommand(
	os: 'linux' | 'windows',
	origin: string,
	code: string
): string {
	switch (os) {
		case 'linux':
			return `chmod +x bmuster-agent && sudo ./bmuster-agent install --url ${origin} --code ${code}`;
		case 'windows':
			return `.\\bmuster-agent.exe install --url ${origin} --code ${code}`;
	}
}

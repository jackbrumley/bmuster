import type { OsFamily } from './machine.ts';

/** Commands an admin runs on the machine itself, shown on the machine's Overview. */
export type AgentCommands = {
	/** Where to run them. */
	shell: string;
	status: string;
	uninstall: string;
	/**
	 * Uninstall and delete the agent's identity and logs; it tells the server first. The agent's
	 * local page shows the same command (agent/crates/agent/src/removal.rs; a test keeps them equal).
	 */
	purge: string;
	/** Move to another server (SPEC-AGENT-LOCAL); the placeholders are filled in by hand. */
	rejoin: string;
};

export function agentCommands(family: OsFamily): AgentCommands {
	switch (family) {
		case 'linux':
		case 'macos':
			return {
				shell: 'In a terminal',
				status: 'sudo /opt/bmuster/versions/current/bmuster-agent status',
				uninstall: 'sudo /opt/bmuster/versions/current/bmuster-agent uninstall',
				purge: 'sudo /opt/bmuster/versions/current/bmuster-agent uninstall --purge',
				rejoin:
					'sudo /opt/bmuster/versions/current/bmuster-agent rejoin --url <new server> --code <join code>'
			};
		case 'windows':
			return {
				shell: 'In PowerShell as administrator',
				status: '& "$env:ProgramFiles\\BMuster\\bmuster-agent.exe" status',
				uninstall: '& "$env:ProgramFiles\\BMuster\\bmuster-agent.exe" uninstall',
				purge: '& "$env:ProgramFiles\\BMuster\\bmuster-agent.exe" uninstall --purge',
				rejoin:
					'& "$env:ProgramFiles\\BMuster\\bmuster-agent.exe" rejoin --url <new server> --code <join code>'
			};
	}
}

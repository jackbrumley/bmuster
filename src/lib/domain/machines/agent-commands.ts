import type { OsFamily } from './machine.ts';

/** Commands an admin runs on the machine itself, shown on the machine's Overview. */
export type AgentCommands = {
	/** Where to run them. */
	shell: string;
	status: string;
	uninstall: string;
	/** Uninstall and delete the agent's identity and logs. */
	purge: string;
};

export function agentCommands(family: OsFamily): AgentCommands {
	switch (family) {
		case 'linux':
		case 'macos':
			return {
				shell: 'In a terminal',
				status: 'sudo /opt/bmuster/bmuster-agent status',
				uninstall: 'sudo /opt/bmuster/bmuster-agent uninstall',
				purge: 'sudo /opt/bmuster/bmuster-agent uninstall --purge'
			};
		case 'windows':
			return {
				shell: 'In PowerShell as administrator',
				status: '& "$env:ProgramFiles\\BMuster\\bmuster-agent.exe" status',
				uninstall: '& "$env:ProgramFiles\\BMuster\\bmuster-agent.exe" uninstall',
				purge: '& "$env:ProgramFiles\\BMuster\\bmuster-agent.exe" uninstall --purge'
			};
	}
}

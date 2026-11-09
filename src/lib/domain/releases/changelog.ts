/** Release notes shared by the console and release packaging. */
export const CHANGELOG = [
	{
		version: '0.4.0',
		changes: [
			'Agents send their logs to the server all the time, keeping them while offline, so Manage shows a machine’s logs even after a crash or restart.',
			'Turn on verbose logging for one machine for up to four hours from Manage.',
			'Show each machine’s screen setup (session type, desktop, graphics cards, input support) on a new Display card.',
			'Add read-only diagnostics tokens in Settings so support tools can read machine logs and reports.',
			'Linux machines on Wayland now show the sign-in screen, the lock screen and text consoles, and can be controlled without approval at the machine.',
			'The server updates itself completely, including its launcher and runtime, and rolls back a release that does not start. Servers on 0.3.x need the installer run once more to move to this.',
			'Agents update their own launcher and roll back to the previous version if a new one cannot start.',
			'The install script checks the release signature before installing.'
		]
	},
	{
		version: '0.3.3',
		changes: [
			'Keep the Updates page open while the server restarts, and reconnect automatically when it returns or rolls back.'
		]
	},
	{
		version: '0.3.2',
		changes: [
			'Retry temporary server update check failures and make failed checks retry automatically.',
			'Show an inconclusive update status when GitHub cannot confirm the latest release.'
		]
	},
	{
		version: '0.3.1',
		changes: [
			'Make Quick join the primary path on Add a machine, with manual installation kept below it.',
			'Add recent agent logs and bounded Linux service diagnostics to each machine’s Manage page.',
			'Fix the Wayland approval action so its request reaches the agent and shows progress.',
			'Simplify the Machines table by removing CPU, memory and disk columns.'
		]
	},
	{
		version: '0.3.0',
		changes: [
			'Add a user-session tray shortcut to local agent management.',
			'Add approved screen sharing and remote input for signed-in Wayland desktops.',
			'Add signed server application updates with manual checks, startup recovery and live agent rollout status.'
		]
	},
	{
		version: '0.2.1',
		changes: [
			'Keep support-code entry compact with grouped digits, and give the following steps more room.'
		]
	},
	{
		version: '0.2.0',
		changes: [
			'Add phone support enrolment at /join with short-lived codes and scam warnings.',
			'Show themed error pages with recovery actions and server error references.',
			'Include the remote terminal, files, X11 desktop, access rules and signed agent updates built during initial development.'
		]
	}
] as const;

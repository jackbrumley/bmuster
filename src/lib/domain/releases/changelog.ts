/** Release notes shared by the console and release packaging. */
export const CHANGELOG = [
	{
		version: '0.4.9',
		changes: [
			'The console starts in light mode. Choosing System or Dark is remembered in that browser.',
			'A new BMuster icon: a light radar with a sweeping beam, the same everywhere: the browser tab, phone home screens, the console logo, the agent’s local page and the Linux tray.'
		]
	},
	{
		version: '0.4.8',
		changes: [
			'On Linux, the BMuster tray icon now appears for everyone already signed in at a desktop, not only after their next sign-in, and its startup entry always points at the current version.',
			'A new self-check, “Tray icon in each signed-in desktop”, says for each signed-in person whether the startup entry, the tray helper and a tray to show it in are all there.'
		]
	},
	{
		version: '0.4.7',
		changes: [
			'Connecting to a machine whose screen has gone dark wakes it, and the screen stays on (and does not lock) while you control it. A laptop with its lid closed says so.',
			'A machine does not idle-sleep while any remote session is open on it; sleep someone asks for at the machine still works.',
			'The Keys menu is compact: the everyday shortcuts are small buttons, and More opens the rest, the custom combination and Release all keys.',
			'While the server updates, the Updates page shows the radar alone; release notes show the newest version, with earlier versions folded away.'
		]
	},
	{
		version: '0.4.6',
		changes: [
			'The remote desktop has a Keys menu at every screen size: Ctrl+Alt+Del, the Windows or Super key, Alt+Tab, Alt+F4, lock, show desktop, Print Screen and more, labelled for the machine’s system, plus any combination you build and Release all keys.',
			'On Linux, Ctrl+Alt+Del asks first, because at a text console it restarts the machine.',
			'Sessions cut off by a server update or restart are now recorded as ended when the server starts, instead of showing as running for ever.'
		]
	},
	{
		version: '0.4.5',
		changes: [
			'On Linux, the agent’s program files move to /opt/bmuster and its data stays in /var/lib/bmuster, so systemd may start its session helpers on SELinux machines such as Fedora. Installed agents move themselves on their next start.',
			'A self-check that is refused by the system’s security policy runs once per agent version, so the machine is not shown a security alert every six hours.',
			'Add Stay awake on mains power to each machine’s Manage page: the machine does not idle-sleep while plugged in (USB-C chargers included) and sleeps normally on battery.',
			'Show a calm radar and a soft loading veil while the server updates and restarts, while logs, checks and files load, and while a desktop connects.'
		]
	},
	{
		version: '0.4.4',
		changes: [
			'On Linux, each terminal, command, file and desktop session’s helper now connects back to the agent over its own private socket. systemd is no longer handed the agent’s terminal or pipes, which SELinux (as on Fedora) refuses and which stopped those sessions from starting.',
			'The self-checks “Unit connects back to the agent” and “Terminal unit with its own pty” replace the two checks that tested the old way.'
		]
	},
	{
		version: '0.4.3',
		changes: [
			'Agents check what they can do on their machine a minute after they start, every six hours and after a failed session, and Manage shows each check passing or failing with the reason. Admins can run them again with Run checks.',
			'When the agent crashes or stops unexpectedly, the reason and its last messages are recorded and sent to the server after it restarts.',
			'Manage lists recent sessions with the steps each one took, and desktop sessions report their frame rate, timings and capture method every 30 seconds.',
			'Windows machines send their desktop helper’s log and, after a failure, the related Windows event log entries; the Display card shows the Windows build, console session, screens and Ctrl+Alt+Del policy.',
			'The diagnostics command line can follow logs, show checks and sessions, watch a machine, and print raw JSON.'
		]
	},
	{
		version: '0.4.2',
		changes: [
			'Show SELinux’s mode and the agent’s and systemd’s security contexts on the Display card.',
			'When a session fails to start, also send the SELinux and other audit denials from the last 15 minutes.',
			'Send the console capture helper’s errors to the server, and run the startup diagnostics when it fails to start.'
		]
	},
	{
		version: '0.4.1',
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

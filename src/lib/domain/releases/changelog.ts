/** Release notes shared by the console and release packaging. */
export const CHANGELOG = [
	{
		version: '0.4.20',
		changes: [
			'Windows: no more black console window at sign-in, and the tray icon appears within seconds, waits for the taskbar and always runs the current version',
			'Windows: the text cursor (I-beam) shows over white areas such as Notepad',
			'KDE Plasma: capital letters type as capitals, also at the lock screen, and Caps Lock is respected',
			'Terminal: turning the phone re-wraps the lines to the new width, and Windows consoles no longer leave stale breaks',
			'Phones: the machine header, Storage and the Table view stay inside the screen; In use sits under the name',
			'Phones: tab rows show they scroll, and pages use more of the screen',
			'New machines stay awake on mains power by default'
		]
	},
	{
		version: '0.4.19',
		changes: [
			'On Windows, the BMuster tray icon now appears for everyone already signed in, within about a minute, running as that person and never with administrator rights',
			'Windows shows the BMuster radar as the tray icon (with a red dot while someone is connected) and as the program icon'
		]
	},
	{
		version: '0.4.18',
		changes: [
			'Storage clean-up: a fixed list of known-safe items for each system (temp folders, update caches, crash dumps, Recycle Bins, package caches, old journal entries and more), each sized first, ticked, confirmed and recorded in Activity with the space freed',
			'Low disk alerts: a drive at 90% or more shows on the Machines list (with a Low disk filter) and on the machine, and can send an email',
			'Rescan now answers at once: the Storage tab shows the machine being asked, or that it is already scanning',
			'On KDE Plasma desktops, All screens and click placement follow the real monitor layout',
			'The machines CSV export leaves out CPU and memory use, which change second by second; Linux disks are listed once per file system, and Windows graphics cards are found even when WMI is damaged',
			'The text on the update screen is no longer squeezed onto several lines'
		]
	},
	{
		version: '0.4.17',
		changes: [
			'A new Storage tab shows where disk space goes on each machine, from a slow, low-priority background scan that is ready before you need it, even on a full disk',
			'Desktop picture: High keeps full colour detail, and a new Extra high setting is close to native for text',
			'Fixed: on Linux machines captured from the graphics card, scales below 100% showed a black screen',
			'The on-screen notice folds to a small pill after a few seconds and opens again under the pointer; on Wayland desktops the tray icon, a notification and the tray menu show who is connected, with Disconnect',
			'The agent page on each machine shows who manages it, who is connected right now and the command to remove BMuster, before any sign-in; removing it at the machine is recorded in Activity',
			'Tray helpers pick up a new agent version by themselves, without signing out'
		]
	},
	{
		version: '0.4.16',
		changes: [
			'Fixed: the Windows remote desktop dropped a moment after the first picture, so the screen froze and could not be controlled',
			'While the server updates, the Updates page says what is happening, counts down the usual minute and says the page reloads by itself',
			'The BMuster is available notice no longer shows during an update or on the Updates page',
			'The Windows SendInput self-check no longer reports a false failure'
		]
	},
	{
		version: '0.4.15',
		changes: [
			'New icon: a round night radar with no tile, the same drawing at every size; the Linux tray draws it sharp at any panel size',
			'One loading spinner everywhere: the icon come alive, with the beam turning and the contacts lighting up',
			'The machines CSV export carries every detail the machine page shows: graphics cards, disks, network adapters, display, hardware and OS details',
			'The machine Overview shows network adapters with MAC addresses, graphics vendor and driver, uptime and power',
			'The join page talks about enrolling a computer with an enrolment code, and the sign-in page links to it',
			'Fixed: installing on Windows 10 stopped with Access is denied while setting the service’s restart rules'
		]
	},
	{
		version: '0.4.14',
		changes: [
			'Add a Test channel: a built-in Test machine group gets agent test builds (tags like v0.4.15-test.1) straight away, while every other machine stays on full releases. The Updates page shows the channel of each machine.'
		]
	},
	{
		version: '0.4.13',
		changes: [
			'The Linux tray icon now starts in signed-in desktops on SELinux machines such as Fedora, where 0.4.12 could not start it.'
		]
	},
	{
		version: '0.4.12',
		changes: [
			'A machine with two or more screens offers All screens: every monitor in one wide picture at its real position, so you can drag a window from one screen onto the next.',
			'On GNOME, clicks now land exactly on stacked or scaled screen layouts, using the desktop’s own arrangement.',
			'The Linux applications menu and startup entries show the BMuster icon.'
		]
	},
	{
		version: '0.4.11',
		changes: [
			'On a phone or tablet in full screen, a round floating button replaces the top bar: drag it to either edge and it stays there, and a tap opens the keys, the phone keyboard, touch or trackpad, screens, picture settings and Disconnect.',
			'Full screen works on iPhone too: where the browser cannot make the page full screen, the desktop fills the window instead.'
		]
	},
	{
		version: '0.4.10',
		changes: [
			'On Linux machines captured directly from the graphics card, windows the desktop draws on a separate hardware layer (as GNOME does for some apps, such as LocalSend) now show in place, instead of missing or stretched across the screen.'
		]
	},
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

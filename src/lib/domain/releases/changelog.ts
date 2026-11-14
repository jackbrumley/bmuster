/** Release notes shared by the console and release packaging. */

/**
 * What to try on real machines before trusting a release: the checks the
 * automated tests cannot make (a phone in the hand, a real desktop, SELinux
 * enforcing). Shown on the Updates page and in the GitHub release notes.
 */
type ReleaseTesting = { kind: 'none' } | { kind: 'steps'; steps: readonly [string, ...string[]] };

export type Release = {
	version: string;
	testing: ReleaseTesting;
	changes: readonly [string, ...string[]];
};

export const CHANGELOG = [
	{
		version: '0.4.30',
		testing: {
			kind: 'steps',
			steps: [
				'Account: Set up two-factor sign-in, scan the QR code with your authenticator app (light and dark theme), enter the first code; save the 10 recovery codes with Download and Copy',
				'Sign out and in: after the password, the code step opens the number pad on a phone and accepts the current code once only; try a recovery code typed in lower case',
				'Settings, Security: choose Required for admins; another admin without it is taken to set-up at their next sign-in',
				'More than 10 minutes after signing in, start a Commands run or approve an AI request: it asks for your authenticator code',
				'Users: Reset two-factor on another person, with confirmation; Activity shows each step'
			]
		},
		changes: [
			'Two-factor sign-in: turn on an authenticator app (Google or Microsoft Authenticator, 1Password, Bitwarden and others) from your Account page by scanning a QR code, and keep 10 single-use recovery codes for a lost phone',
			'Settings, Security: require two-factor sign-in for admins or for everyone who signs in with a password. New servers require it for admins; servers that update stay off until you choose. People who sign in through Microsoft 365 or Authentik are never asked',
			'With two-factor on, the check before a Commands run or an AI approval asks for your authenticator code instead of your password',
			'Admins can reset someone’s two-factor on the Users page; a host command resets it for a locked-out last admin (see the hosting guide)'
		]
	},
	{
		version: '0.4.29',
		testing: {
			kind: 'steps',
			steps: [
				'With an assistant connected (0.4.27 steps), ask it to check something on one machine, such as uptime: a notice appears in BMuster; open it, check the command and machine, Approve within 45 s; the assistant answers with the output',
				'Ask for another command and wait over a minute before approving: the assistant keeps checking and still gets the output',
				'Deny one with a note: the assistant reads the note; Edit one then approve: the assistant sees what actually ran',
				'Leave one for 10 minutes: it expires and the assistant is told; Activity shows each request and decision as you via the assistant',
				'Approve from your phone: the card fits, the decision bar sits above the home bar, and it asks for your password after 10 minutes'
			]
		},
		changes: [
			'AI assistants can now ask to run commands on your machines. Nothing runs until a person approves it in BMuster: the Approvals page shows the exact command, every machine, the shell and the assistant’s reason, with Approve, Edit then approve, or Deny with a note the assistant reads',
			'Approving asks for your password if you signed in more than 10 minutes ago; requests nobody decides expire after 10 minutes; at most 10 machines per request; every request, decision and result is in Activity as you via the assistant',
			'A notice appears in every open BMuster tab when a request arrives, and an optional email notification rule can tell you too. If you approve within 45 seconds the assistant gets the output straight away; otherwise it keeps checking until the command finishes',
			'Settings, AI assistants: choose who may approve (the person who asked, an approvers group, or both)'
		]
	},
	{
		version: '0.4.28',
		testing: {
			kind: 'steps',
			steps: [
				'As an admin on a server older than 14 days with machines: the slim line shows at the bottom of Machines on desktop and phone, and nowhere else',
				'Not now hides it; as a member it never shows; Donate opens bmuster.com/donate in a new tab'
			]
		},
		changes: [
			'A small donation reminder for admins at the bottom of the Machines page, from a server’s 14th day: Donate opens bmuster.com/donate (GitHub Sponsors or PayPal), Not now hides it for 5 days, I’ve donated hides it for 90. It never shows to members, guests or on the managed computers, and BMuster sends nothing about it'
		]
	},
	{
		version: '0.4.27',
		testing: {
			kind: 'steps',
			steps: [
				'Settings, AI assistants: make a user group with you in it, choose it, turn it on; read the help panel and copy the address',
				'Access: add a rule giving your group AI commands on one machine group (admins do not get it automatically)',
				'Claude Code: claude mcp add --transport http bmuster https://bmuster.brumley.info/mcp, then /mcp to sign in; the consent screen names the assistant; ask it to list your machines',
				'claude.ai (or another assistant): add https://bmuster.brumley.info/mcp as a custom connector, sign in, ask about one machine; only machines your rule opens appear',
				'Activity shows the connection and each tool call as you via the assistant; Account, Disconnect ends it at once; Settings, Stop all AI access ends every connection'
			]
		},
		changes: [
			'AI assistants (MCP): connect Claude, ChatGPT or any other assistant that supports MCP to BMuster, so it can list your machines and read their details. Off by default: turn it on in Settings, AI assistants',
			'AI assistants: an assistant only sees machines an access rule opens to AI (the new AI commands permission), signs in through BMuster with your approval, and can be disconnected from your Account page or stopped for everyone in Settings',
			'AI assistants: Activity shows what each assistant did as you, and a banner shows while one is connected. Asking to run commands, with your approval each time, comes next'
		]
	},
	{
		version: '0.4.26',
		testing: {
			kind: 'steps',
			steps: [
				'Update the server, then wait until both machines report 0.4.26 (older agents are skipped as too old)',
				'Machines: press Select, tap a group chip, Select all, untick one; the bottom bar shows the right count on desktop and phone',
				'Run hostname on Windows and Fedora together: one box per system, Review lists both, the confirm names the count; both rows end succeeded with the right output',
				'Run a failing command (exit 1) and one with a 5 s time limit that sleeps 30 s: rows show failed and timed out; Run again on failed and offline opens with just those',
				'Wait 10 minutes after signing in, start a run: it asks for your password first; a wrong password is refused',
				'Switch a machine off, run on it: its row shows Offline; Activity shows the run start, each result and the end'
			]
		},
		changes: [
			'Commands: run one command on many machines at once. On Machines, press Select, tick machines or pick groups (and Windows, Linux, Online), Select all, then Run command',
			'Commands: review every machine and the exact command before it runs, confirm with the machine count, and enter your password if you signed in more than 10 minutes ago',
			'Commands: watch each machine’s result live, see its output, cancel, or run again on the ones that failed or were offline; past runs are on the new Commands tab',
			'Access: a new Run commands permission, separate from Terminal; admins have it everywhere, anyone else needs an access rule'
		]
	},
	{
		version: '0.4.25',
		testing: {
			kind: 'steps',
			steps: [
				'Windows: in Explorer, right-click C:\\Program Files\\BMuster\\bmuster-agent.exe, Properties, Details: it shows BMuster, BMuster agent and 0.4.25',
				'Windows: on a machine where Microsoft Defender blocks the agent, the install line stops with the BMuster message about Protection history and installs nothing'
			]
		},
		changes: [
			'Windows install: when Microsoft Defender or another antivirus blocks the downloaded agent, the install line now stops with a plain reason and points to Protection history, instead of a confusing second error',
			'Windows: the agent program now carries its name, publisher, description and version (Properties, Details), which antivirus products look for'
		]
	},
	{
		version: '0.4.24',
		testing: {
			kind: 'steps',
			steps: [
				'Windows: copy text in Notepad on the machine; it should be on your device’s clipboard (phone: after one tap in BMuster, with “Copied from the machine”)',
				'Phone to Windows: copy in Notes, open the BMuster keyboard, tap the keyboard’s clipboard suggestion (or long-press, Paste); see “Ready to paste on the machine”, then right-click, Paste in Notepad',
				'Desktop browser: press Allow clipboard sharing once, copy something on your computer, click back into BMuster, then right-click, Paste on the machine',
				'Fedora KDE signed in: the same both ways; then lock the screen and check the Clipboard tab says it is not available while locked',
				'Phone, zoomed Trackpad: with the whole height on screen, moving up or down never pans; pushing the cursor into an edge pans one to one, pulling back stops at once, holding still at the edge creeps',
				'Updates page: the confirmation is short, the notes show as headings and lists, and the update wait covers the whole screen'
			]
		},
		changes: [
			'Clipboard shared both ways while you control: copy on the machine and it is on your device; copy on a desktop browser and paste on the machine; on a phone, paste into the BMuster keyboard to send it',
			'Copy and paste on Linux desktops through the direct screen path (KDE, GNOME, Sway, Hyprland and other Wayland desktops, and X11), refused while the machine is locked',
			'Phone, zoomed Trackpad: an axis that fits never pans, the picture never slides past its edges, the cursor pushes the view, and a still finger at the edge creeps it along',
			'The update confirmation says only what the update does, and the release notes show as headings and lists',
			'While the server updates, the wait screen covers the whole console'
		]
	},
	{
		version: '0.4.23',
		testing: {
			kind: 'steps',
			steps: [
				'Phone, Trackpad: tap once on a desktop icon (one click), tap twice and release to open it (double click), then tap and touch-and-hold on a window title bar and drag it (it moves, it does not maximise)',
				'Phone, Fixed cursor: the same three taps; no crosshair shows over the cursor',
				'Phone, Trackpad zoomed in a long way: push the cursor to each edge and hold your finger still; the view keeps panning with the cursor until you drag it back towards the centre'
			]
		},
		changes: [
			'Phone, Trackpad and Fixed cursor: tap twice and release to double click; tap, then touch and hold to press and drag with no extra click',
			'Phone, Trackpad while zoomed: the cursor stays on screen, and holding it near an edge keeps panning like a joystick until you move it back',
			'Fixed cursor mode no longer draws a crosshair over the cursor'
		]
	},
	{
		version: '0.4.22',
		testing: {
			kind: 'steps',
			steps: [
				'Phone: tap Connect on the desktop tab; it should go straight into full screen, and outside full screen only Full screen and Disconnect show',
				'Phone, trackpad mode: tap twice quickly to open a folder (double click); tap, then tap and hold to drag a window',
				'Phone: pick Fixed cursor in the sheet’s Session tab; drag to move the picture under the centred cursor and reach every corner',
				'Phone: pinch in, then move the cursor towards an edge; the picture should pan to follow',
				'Phone: turn the phone in full screen; the picture should refit and stay sharp; change Quality in the sheet and see it apply at once',
				'Leave Quality on Auto on a good link; the Picture tab should reach Auto (Extra high) within a few seconds',
				'Desktop browser: move the mouse over the picture; the cursor should follow with no lag and change shape over text and window edges',
				'Desktop browser: Pop out the desktop into a window, resize it, then Bring it back',
				'Copy and paste: send text to Windows and to the signed-in Fedora KDE desktop, then copy text on each and Get from machine (KDE needs Plasma 6.5.3 or later)',
				'Share link: create one from a machine’s Overview, open it in a private window, enter a name, connect; the machine shows the guest’s name; check Activity, then End now',
				'Overview on the phone: scroll down and wait 10 seconds; it should stay where you scrolled',
				'Restart a machine during a session; the badge and tabs should show Reconnecting, then Offline, then reopen by themselves',
				'Windows: the Overview Display card lists the monitors, and the Start menu BMuster entry opens the local page without a console window'
			]
		},
		changes: [
			'Share links: give someone without an account time-limited access (15 minutes to 7 days) to one machine; they enter their name, the machine shows who is connected, and every use is recorded with their address',
			'Copy and paste on the remote desktop (Windows, X11 and signed-in Wayland desktops), from a Clipboard tab or button',
			'The remote cursor is drawn by your own computer, so it follows the mouse with no lag',
			'Pop out a desktop into its own resizable window, and keep several open at once',
			'Phones go straight into full screen when you connect, with a simpler page outside it',
			'Phone gestures: double tap to double click, double tap and hold to drag, the picture pans to follow the cursor while zoomed, and a new Fixed cursor mode; one Touch input choice everywhere',
			'Auto quality aims for the best picture the link holds, up to Extra high, and shows the level it picked; quality changes apply at once in full screen and after turning the phone',
			'The machine Overview no longer jumps back to the top while its figures refresh',
			'Windows: the Display card lists the monitors, and the Start menu entry opens the local page without a console window',
			'Quieter agent logs: proxy error pages are no longer copied in, repeats fold into one line, and diagnostics can page back through the whole week',
			'Release notes list what to test on real machines'
		]
	},
	{
		version: '0.4.21',
		testing: { kind: 'none' },
		changes: [
			'Phone desktop: the menu button sits on any edge and opens a larger panel (a bottom sheet in portrait, a side panel in landscape) with Keys, Picture, Screen and Session tabs',
			'Phone desktop: pinch to zoom and pan the picture, long press for a right click, and an easier double-tap and drag',
			'Online status is the same everywhere: Reconnecting shows at once when a machine drops, every tab follows it live, and pages catch up when you come back to them'
		]
	},
	{
		version: '0.4.20',
		testing: { kind: 'none' },
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
		testing: { kind: 'none' },
		changes: [
			'On Windows, the BMuster tray icon now appears for everyone already signed in, within about a minute, running as that person and never with administrator rights',
			'Windows shows the BMuster radar as the tray icon (with a red dot while someone is connected) and as the program icon'
		]
	},
	{
		version: '0.4.18',
		testing: { kind: 'none' },
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
		testing: { kind: 'none' },
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
		testing: { kind: 'none' },
		changes: [
			'Fixed: the Windows remote desktop dropped a moment after the first picture, so the screen froze and could not be controlled',
			'While the server updates, the Updates page says what is happening, counts down the usual minute and says the page reloads by itself',
			'The BMuster is available notice no longer shows during an update or on the Updates page',
			'The Windows SendInput self-check no longer reports a false failure'
		]
	},
	{
		version: '0.4.15',
		testing: { kind: 'none' },
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
		testing: { kind: 'none' },
		changes: [
			'Add a Test channel: a built-in Test machine group gets agent test builds (tags like v0.4.15-test.1) straight away, while every other machine stays on full releases. The Updates page shows the channel of each machine.'
		]
	},
	{
		version: '0.4.13',
		testing: { kind: 'none' },
		changes: [
			'The Linux tray icon now starts in signed-in desktops on SELinux machines such as Fedora, where 0.4.12 could not start it.'
		]
	},
	{
		version: '0.4.12',
		testing: { kind: 'none' },
		changes: [
			'A machine with two or more screens offers All screens: every monitor in one wide picture at its real position, so you can drag a window from one screen onto the next.',
			'On GNOME, clicks now land exactly on stacked or scaled screen layouts, using the desktop’s own arrangement.',
			'The Linux applications menu and startup entries show the BMuster icon.'
		]
	},
	{
		version: '0.4.11',
		testing: { kind: 'none' },
		changes: [
			'On a phone or tablet in full screen, a round floating button replaces the top bar: drag it to either edge and it stays there, and a tap opens the keys, the phone keyboard, touch or trackpad, screens, picture settings and Disconnect.',
			'Full screen works on iPhone too: where the browser cannot make the page full screen, the desktop fills the window instead.'
		]
	},
	{
		version: '0.4.10',
		testing: { kind: 'none' },
		changes: [
			'On Linux machines captured directly from the graphics card, windows the desktop draws on a separate hardware layer (as GNOME does for some apps, such as LocalSend) now show in place, instead of missing or stretched across the screen.'
		]
	},
	{
		version: '0.4.9',
		testing: { kind: 'none' },
		changes: [
			'The console starts in light mode. Choosing System or Dark is remembered in that browser.',
			'A new BMuster icon: a light radar with a sweeping beam, the same everywhere: the browser tab, phone home screens, the console logo, the agent’s local page and the Linux tray.'
		]
	},
	{
		version: '0.4.8',
		testing: { kind: 'none' },
		changes: [
			'On Linux, the BMuster tray icon now appears for everyone already signed in at a desktop, not only after their next sign-in, and its startup entry always points at the current version.',
			'A new self-check, “Tray icon in each signed-in desktop”, says for each signed-in person whether the startup entry, the tray helper and a tray to show it in are all there.'
		]
	},
	{
		version: '0.4.7',
		testing: { kind: 'none' },
		changes: [
			'Connecting to a machine whose screen has gone dark wakes it, and the screen stays on (and does not lock) while you control it. A laptop with its lid closed says so.',
			'A machine does not idle-sleep while any remote session is open on it; sleep someone asks for at the machine still works.',
			'The Keys menu is compact: the everyday shortcuts are small buttons, and More opens the rest, the custom combination and Release all keys.',
			'While the server updates, the Updates page shows the radar alone; release notes show the newest version, with earlier versions folded away.'
		]
	},
	{
		version: '0.4.6',
		testing: { kind: 'none' },
		changes: [
			'The remote desktop has a Keys menu at every screen size: Ctrl+Alt+Del, the Windows or Super key, Alt+Tab, Alt+F4, lock, show desktop, Print Screen and more, labelled for the machine’s system, plus any combination you build and Release all keys.',
			'On Linux, Ctrl+Alt+Del asks first, because at a text console it restarts the machine.',
			'Sessions cut off by a server update or restart are now recorded as ended when the server starts, instead of showing as running for ever.'
		]
	},
	{
		version: '0.4.5',
		testing: { kind: 'none' },
		changes: [
			'On Linux, the agent’s program files move to /opt/bmuster and its data stays in /var/lib/bmuster, so systemd may start its session helpers on SELinux machines such as Fedora. Installed agents move themselves on their next start.',
			'A self-check that is refused by the system’s security policy runs once per agent version, so the machine is not shown a security alert every six hours.',
			'Add Stay awake on mains power to each machine’s Manage page: the machine does not idle-sleep while plugged in (USB-C chargers included) and sleeps normally on battery.',
			'Show a calm radar and a soft loading veil while the server updates and restarts, while logs, checks and files load, and while a desktop connects.'
		]
	},
	{
		version: '0.4.4',
		testing: { kind: 'none' },
		changes: [
			'On Linux, each terminal, command, file and desktop session’s helper now connects back to the agent over its own private socket. systemd is no longer handed the agent’s terminal or pipes, which SELinux (as on Fedora) refuses and which stopped those sessions from starting.',
			'The self-checks “Unit connects back to the agent” and “Terminal unit with its own pty” replace the two checks that tested the old way.'
		]
	},
	{
		version: '0.4.3',
		testing: { kind: 'none' },
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
		testing: { kind: 'none' },
		changes: [
			'Show SELinux’s mode and the agent’s and systemd’s security contexts on the Display card.',
			'When a session fails to start, also send the SELinux and other audit denials from the last 15 minutes.',
			'Send the console capture helper’s errors to the server, and run the startup diagnostics when it fails to start.'
		]
	},
	{
		version: '0.4.1',
		testing: { kind: 'none' },
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
		testing: { kind: 'none' },
		changes: [
			'Keep the Updates page open while the server restarts, and reconnect automatically when it returns or rolls back.'
		]
	},
	{
		version: '0.3.2',
		testing: { kind: 'none' },
		changes: [
			'Retry temporary server update check failures and make failed checks retry automatically.',
			'Show an inconclusive update status when GitHub cannot confirm the latest release.'
		]
	},
	{
		version: '0.3.1',
		testing: { kind: 'none' },
		changes: [
			'Make Quick join the primary path on Add a machine, with manual installation kept below it.',
			'Add recent agent logs and bounded Linux service diagnostics to each machine’s Manage page.',
			'Fix the Wayland approval action so its request reaches the agent and shows progress.',
			'Simplify the Machines table by removing CPU, memory and disk columns.'
		]
	},
	{
		version: '0.3.0',
		testing: { kind: 'none' },
		changes: [
			'Add a user-session tray shortcut to local agent management.',
			'Add approved screen sharing and remote input for signed-in Wayland desktops.',
			'Add signed server application updates with manual checks, startup recovery and live agent rollout status.'
		]
	},
	{
		version: '0.2.1',
		testing: { kind: 'none' },
		changes: [
			'Keep support-code entry compact with grouped digits, and give the following steps more room.'
		]
	},
	{
		version: '0.2.0',
		testing: { kind: 'none' },
		changes: [
			'Add phone support enrolment at /join with short-lived codes and scam warnings.',
			'Show themed error pages with recovery actions and server error references.',
			'Include the remote terminal, files, X11 desktop, access rules and signed agent updates built during initial development.'
		]
	}
] as const satisfies readonly [Release, ...Release[]];

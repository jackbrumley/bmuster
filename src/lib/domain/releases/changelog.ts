/** Release notes shared by the console and release packaging. */
export const CHANGELOG = [
	{
		version: '0.2.0',
		changes: [
			'Add phone support enrolment at /join with short-lived codes and scam warnings.',
			'Show themed error pages with recovery actions and server error references.',
			'Include the remote terminal, files, X11 desktop, access rules and signed agent updates built during initial development.'
		]
	}
] as const;

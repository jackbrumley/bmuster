/**
 * What the screen at the machine shows, from the agent's `state` message
 * (SPEC-DESKTOP 5.2). Generic across platforms: Linux follows seat0
 * through logind, Windows the input desktop. Browser-safe.
 */

export type DesktopScreen =
	| { kind: 'sign-in' }
	| { kind: 'locked'; user: string | null }
	| { kind: 'desktop'; user: string | null }
	| { kind: 'unavailable'; reason: string }
	| { kind: 'approval'; phase: 'needed' | 'pending' | 'declined'; message: string };

/** The status line on the Desktop tab: "Sign-in screen", "jack's desktop · locked". */
export function screenLabel(screen: DesktopScreen): string {
	switch (screen.kind) {
		case 'sign-in':
			return 'Sign-in screen';
		case 'locked':
			return screen.user === null ? 'Desktop · locked' : `${screen.user}'s desktop · locked`;
		case 'desktop':
			return screen.user === null ? 'Desktop' : `${screen.user}'s desktop`;
		case 'approval':
			return screen.message;
		case 'unavailable':
			return `Screen not available: ${screen.reason}`;
	}
}

import type { IWindowsPty } from '@xterm/xterm';
import type { Machine } from '#lib/domain/machines/machine.ts';

/**
 * What xterm.js is told about a Windows machine's pseudo console
 * (SPEC-SESSIONS T10). The agent runs shells in ConPTY, which redraws the
 * screen itself when the size changes; xterm.js reflows alongside it only
 * on builds where ConPTY passes wrapped lines through (21376 and later),
 * and otherwise leaves reflowing to ConPTY. Linux and macOS get nothing:
 * their PTYs do not redraw, so xterm.js reflows.
 */

/** The first Windows build with ConPTY (Windows 10 1809), assumed until inventory says more. */
export const OLDEST_CONPTY_BUILD = 17763;

/** The Windows build from the inventory's OS build (`22631`, or `10.0.22631` on some reports). */
function buildNumber(osBuild: string): number | undefined {
	const parts = osBuild.match(/\d+/g) ?? [];
	const build = parts
		.map(Number)
		.reverse()
		.find((part) => part >= 10_000);
	return build;
}

export function windowsPtyFor(machine: Machine): IWindowsPty | undefined {
	switch (machine.osFamily) {
		case 'linux':
		case 'macos':
			return undefined;
		case 'windows': {
			const reported =
				machine.inventory.kind === 'known' ? buildNumber(machine.inventory.osBuild) : undefined;
			return { backend: 'conpty', buildNumber: reported ?? OLDEST_CONPTY_BUILD };
		}
	}
}

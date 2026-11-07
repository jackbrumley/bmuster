/**
 * The shared confirmation for anything destructive (AGENTS.md §12): call
 * `confirmAction()`, await the answer, and only then send the request. The
 * one ConfirmDialog in the console frame shows whatever is asked here.
 */
export type ConfirmOptions = {
	title: string;
	message: string;
	confirmLabel: string;
};

type Pending =
	{ kind: 'none' } | { kind: 'asking'; options: ConfirmOptions; answer: (yes: boolean) => void };

export const confirmation = $state<{ current: Pending }>({ current: { kind: 'none' } });

export function confirmAction(options: ConfirmOptions): Promise<boolean> {
	if (confirmation.current.kind === 'asking') {
		confirmation.current.answer(false);
	}
	return new Promise((resolve) => {
		confirmation.current = {
			kind: 'asking',
			options,
			answer: (yes) => {
				confirmation.current = { kind: 'none' };
				resolve(yes);
			}
		};
	});
}

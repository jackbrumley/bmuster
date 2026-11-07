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

/** `text`: the person must type this exactly (e.g. a machine's name) before confirming. */
type TypedCheck = { kind: 'none' } | { kind: 'text'; text: string };

type Pending =
	| { kind: 'none' }
	| {
			kind: 'asking';
			options: ConfirmOptions;
			typed: TypedCheck;
			answer: (yes: boolean) => void;
	  };

export const confirmation = $state<{ current: Pending }>({ current: { kind: 'none' } });

export function confirmAction(options: ConfirmOptions): Promise<boolean> {
	return ask(options, { kind: 'none' });
}

/**
 * For the most destructive actions: the person types `text` (the thing's name)
 * before the confirm button works. The dialog offers a copy button for it.
 */
export function confirmByTyping(options: ConfirmOptions & { text: string }): Promise<boolean> {
	return ask(options, { kind: 'text', text: options.text });
}

function ask(options: ConfirmOptions, typed: TypedCheck): Promise<boolean> {
	if (confirmation.current.kind === 'asking') {
		confirmation.current.answer(false);
	}
	return new Promise((resolve) => {
		confirmation.current = {
			kind: 'asking',
			options,
			typed,
			answer: (yes) => {
				confirmation.current = { kind: 'none' };
				resolve(yes);
			}
		};
	});
}

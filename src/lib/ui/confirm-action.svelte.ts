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

/**
 * `text`: the person must type this exactly (e.g. a machine's name) before confirming.
 * `count`: they type a number they can see in the message (how many machines, SPEC-COMMANDS C9).
 */
type TypedCheck =
	{ kind: 'none' } | { kind: 'text'; text: string } | { kind: 'count'; count: number };

/** `ask`: the dialog asks for the person's password too (SPEC-COMMANDS C10). */
type PasswordCheck = { kind: 'none' } | { kind: 'ask' };

/** How the dialog was answered; `password` is '' unless it was asked for. */
export type ConfirmAnswer = { kind: 'no' } | { kind: 'yes'; password: string };

type Pending =
	| { kind: 'none' }
	| {
			kind: 'asking';
			options: ConfirmOptions;
			typed: TypedCheck;
			password: PasswordCheck;
			answer: (answer: ConfirmAnswer) => void;
	  };

export const confirmation = $state<{ current: Pending }>({ current: { kind: 'none' } });

export async function confirmAction(options: ConfirmOptions): Promise<boolean> {
	return (await ask(options, { kind: 'none' }, { kind: 'none' })).kind === 'yes';
}

/**
 * For the most destructive actions: the person types `text` (the thing's name)
 * before the confirm button works. The dialog offers a copy button for it.
 */
export async function confirmByTyping(
	options: ConfirmOptions & { text: string }
): Promise<boolean> {
	return (
		(await ask(options, { kind: 'text', text: options.text }, { kind: 'none' })).kind === 'yes'
	);
}

/**
 * Running a command on many machines (SPEC-COMMANDS C9, C10): above a threshold the person types
 * the machine count, and when their sign-in is not recent they give their password, in the same
 * dialog. The server checks both again.
 */
export function confirmWithChecks(
	options: ConfirmOptions & { typedCount: number | null; askPassword: boolean }
): Promise<ConfirmAnswer> {
	return ask(
		options,
		options.typedCount === null ? { kind: 'none' } : { kind: 'count', count: options.typedCount },
		options.askPassword ? { kind: 'ask' } : { kind: 'none' }
	);
}

function ask(
	options: ConfirmOptions,
	typed: TypedCheck,
	password: PasswordCheck
): Promise<ConfirmAnswer> {
	if (confirmation.current.kind === 'asking') {
		confirmation.current.answer({ kind: 'no' });
	}
	return new Promise((resolve) => {
		confirmation.current = {
			kind: 'asking',
			options,
			typed,
			password,
			answer: (answer) => {
				confirmation.current = { kind: 'none' };
				resolve(answer);
			}
		};
	});
}

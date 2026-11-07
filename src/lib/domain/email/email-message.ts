/** Sent, waiting and failed emails, as Settings → Email lists them (SPEC-EMAIL E3, E8). Browser-safe. */

export type EmailKind =
	'test' | 'password-reset' | 'invitation' | 'provider-sign-in' | 'notification';

export function emailKindLabel(kind: EmailKind): string {
	switch (kind) {
		case 'test':
			return 'Test email';
		case 'password-reset':
			return 'Password reset';
		case 'invitation':
			return 'Invitation';
		case 'provider-sign-in':
			return 'Sign-in reminder';
		case 'notification':
			return 'Notification';
	}
}

type EmailMessageStatus =
	| { kind: 'queued'; attempts: number; nextAttemptIso: string; lastError: string | null }
	| { kind: 'sent'; atIso: string; reply: string }
	| { kind: 'failed'; atIso: string; attempts: number; error: string };

export type EmailMessageView = {
	id: string;
	kind: EmailKind;
	to: string;
	subject: string;
	createdIso: string;
	status: EmailMessageStatus;
};

/** What happened to a test email, word for word (E2). */
export type SendResult = { kind: 'sent'; reply: string } | { kind: 'failed'; error: string };

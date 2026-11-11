/**
 * Enrolment codes and the public /join page (SPEC-JOIN): the enrolment code's
 * shape, the scam check's questions, and what the page works out for
 * itself. Browser-safe.
 */

/** How long an enrolment code (and the join code behind it) lasts. */
export const SUPPORT_CODE_MINUTES = 15;

/** An enrolment code as people read it out: "482 913". */
export function formatSupportCode(digits: string): string {
	return `${digits.slice(0, 3)} ${digits.slice(3)}`;
}

/** What a caller typed, as the six digits, or undefined when it cannot be an enrolment code. */
export function supportCodeDigits(typed: string): string | undefined {
	const digits = typed.replace(/[\s-]/g, '');
	return /^\d{6}$/.test(digits) ? digits : undefined;
}

export const SCAM_QUESTION_IDS = ['contacted', 'money', 'virus'] as const;

export type ScamQuestionId = (typeof SCAM_QUESTION_IDS)[number];

export type ScamAnswer = 'yes' | 'no';

export type ScamQuestion = {
	id: ScamQuestionId;
	text: string;
	/** In the order shown: the first is the safe one. */
	options: readonly { value: ScamAnswer; label: string }[];
	safe: ScamAnswer;
};

/** The three questions (J7). Each has one safe answer; any other stops the caller. */
export const SCAM_QUESTIONS: readonly ScamQuestion[] = [
	{
		id: 'contacted',
		text: 'Did this code come from your workplace’s IT, or from someone you contacted yourself?',
		options: [
			{ value: 'yes', label: 'Yes' },
			{ value: 'no', label: 'No' }
		],
		safe: 'yes'
	},
	{
		id: 'money',
		text: 'Has anyone asked you to log in to your bank, buy gift cards, or send money?',
		options: [
			{ value: 'no', label: 'No' },
			{ value: 'yes', label: 'Yes' }
		],
		safe: 'no'
	},
	{
		id: 'virus',
		text: 'Did someone tell you your computer has a virus or has been hacked?',
		options: [
			{ value: 'no', label: 'No' },
			{ value: 'yes', label: 'Yes' }
		],
		safe: 'no'
	}
];

export type ScamAnswers = Record<ScamQuestionId, ScamAnswer | null>;

/** Where the scam check stands: still answering, all safe, or stopped at the first unsafe answer. */
export function scamCheck(
	answers: ScamAnswers
): { kind: 'answering' } | { kind: 'safe' } | { kind: 'stop'; question: ScamQuestionId } {
	const unsafe = SCAM_QUESTIONS.find(
		(question) => answers[question.id] !== null && answers[question.id] !== question.safe
	);
	if (unsafe !== undefined) {
		return { kind: 'stop', question: unsafe.id };
	}
	return SCAM_QUESTIONS.every((question) => answers[question.id] === question.safe)
		? { kind: 'safe' }
		: { kind: 'answering' };
}

/** The computer the page is open on, from its user agent; a phone or tablet is not the one to help. */
export type DetectedComputer = 'windows' | 'linux' | 'macos' | 'phone';

export function detectComputer(userAgent: string): DetectedComputer {
	if (/Android|iPhone|iPad|iPod|Mobile/i.test(userAgent)) {
		return 'phone';
	}
	if (/Windows/i.test(userAgent)) {
		return 'windows';
	}
	if (/Macintosh|Mac OS X/i.test(userAgent)) {
		return 'macos';
	}
	if (/Linux|X11|CrOS/i.test(userAgent)) {
		return 'linux';
	}
	return 'windows';
}

/** Text with its web addresses split out, so a page can show them as links without `{@html}`. */
export type TextPart = { kind: 'text'; text: string } | { kind: 'link'; href: string };

export function textWithLinks(text: string): TextPart[] {
	const parts: TextPart[] = [];
	for (const piece of text.split(/(https:\/\/[^\s,]+[^\s,.;:!?)])/)) {
		if (piece === '') {
			continue;
		}
		parts.push(
			piece.startsWith('https://') ? { kind: 'link', href: piece } : { kind: 'text', text: piece }
		);
	}
	return parts;
}

/** The agent's local page on the machine itself (SPEC-AGENT-LOCAL), its default address. */
export const LOCAL_PAGE_ADDRESS = 'https://localhost:47500';

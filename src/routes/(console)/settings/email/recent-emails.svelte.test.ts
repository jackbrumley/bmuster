import { describe, expect, it } from 'vitest';
import { render } from 'vitest-browser-svelte';
import type { EmailMessageView } from '#lib/domain/email/email-message.ts';
import RecentEmails from './recent-emails.svelte';

const NOW = Date.parse('2026-11-07T10:00:00Z');

const EMAILS: EmailMessageView[] = [
	{
		id: '1',
		kind: 'test',
		to: 'ok@example.test',
		subject: 'BMuster test email',
		createdIso: '2026-11-07T09:59:00Z',
		status: { kind: 'sent', atIso: '2026-11-07T09:59:00Z', reply: 'Accepted by smtp.test (Q1)' }
	},
	{
		id: '2',
		kind: 'notification',
		to: 'later@example.test',
		subject: 'New machine: build-01',
		createdIso: '2026-11-07T09:50:00Z',
		status: {
			kind: 'queued',
			attempts: 3,
			nextAttemptIso: '2026-11-07T10:04:00Z',
			lastError: '421 Try again later'
		}
	},
	{
		id: '3',
		kind: 'password-reset',
		to: 'gone@example.test',
		subject: 'Reset your BMuster password',
		createdIso: '2026-11-07T02:00:00Z',
		status: {
			kind: 'failed',
			atIso: '2026-11-07T06:00:00Z',
			attempts: 8,
			error: '550 Mailbox unavailable'
		}
	}
];

describe('Recent emails (SPEC-EMAIL E3, E8)', () => {
	it('E8: shows each email’s recipient, subject and result', async () => {
		const screen = await render(RecentEmails, { emails: EMAILS, now: NOW });
		await expect.element(screen.getByText('BMuster test email')).toBeVisible();
		await expect.element(screen.getByText(/ok@example.test · Test email/)).toBeVisible();
		await expect.element(screen.getByText(/Accepted by smtp.test \(Q1\)/)).toBeVisible();
	});

	it('E3: shows a message being retried, and one given up, with the error', async () => {
		const screen = await render(RecentEmails, { emails: EMAILS, now: NOW });
		await expect.element(screen.getByText(/Try 3 of 8 failed.*421 Try again later/)).toBeVisible();
		await expect
			.element(screen.getByText(/Gave up after 8 tries · 550 Mailbox unavailable/))
			.toBeVisible();
	});

	it('says so when there are none', async () => {
		const screen = await render(RecentEmails, { emails: [], now: NOW });
		await expect.element(screen.getByText('No emails yet.')).toBeVisible();
	});
});

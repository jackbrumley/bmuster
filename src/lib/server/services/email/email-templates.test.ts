import { describe, expect, it } from 'vitest';
import {
	invitationEmail,
	notificationEmail,
	passwordResetEmail,
	providerInvitationEmail,
	providerSignInEmail,
	renderEmail,
	testEmail
} from './templates.ts';

const EVERY_EMAIL = [
	testEmail('Ada'),
	passwordResetEmail('Ada', 'https://bmuster.test/login/reset/abc', 30),
	providerSignInEmail('Ada', ['Contoso Entra'], 'https://bmuster.test/login'),
	invitationEmail('Ada', 'Grace', 'https://bmuster.test/invite/abc', 7),
	providerInvitationEmail('Ada', 'Grace', [], 'https://bmuster.test/login'),
	notificationEmail({
		subject: 'New machine: build-01',
		heading: 'A machine joined BMuster',
		summary: 'build-01 enrolled with a join code.',
		facts: [{ label: 'Machine', value: 'build-01' }],
		url: 'https://bmuster.test/machines/1',
		ruleDescription: 'Machine enrolled · Any machine'
	})
];

describe('email templates (E7)', () => {
	it('gives every email a plain text part and an HTML part that say the same thing', () => {
		for (const email of EVERY_EMAIL) {
			expect(email.text.length).toBeGreaterThan(0);
			expect(email.html).toMatch(/^<!doctype html>/);
			const firstLine = email.text.split('\n')[0] ?? '';
			expect(email.html).toContain(firstLine);
		}
	});

	it('puts the link in both parts', () => {
		const email = passwordResetEmail('Ada', 'https://bmuster.test/login/reset/abc', 30);
		expect(email.text).toContain('https://bmuster.test/login/reset/abc');
		expect(email.html).toContain('href="https://bmuster.test/login/reset/abc"');
	});

	it('has no tracking: no images, no remote content, only the links it was given', () => {
		for (const email of EVERY_EMAIL) {
			expect(email.html).not.toMatch(/<img|<script|<link|<iframe|url\(/i);
			const hrefs = [...email.html.matchAll(/href="([^"]*)"/g)].map((match) => match[1]);
			for (const href of hrefs) {
				expect(email.text).toContain(href);
			}
		}
	});

	it('escapes everything it is given, so a name cannot inject HTML', () => {
		const email = renderEmail({
			subject: '<b>x</b>',
			heading: '<script>alert(1)</script>',
			blocks: [
				{ kind: 'paragraph', text: '"quoted" & <tag>' },
				{ kind: 'button', label: 'Go', url: 'https://x.test/?a="><script>' }
			],
			footer: '<i>footer</i>'
		});
		expect(email.html).not.toContain('<script>');
		expect(email.html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
		expect(email.html).toContain('&quot;quoted&quot; &amp; &lt;tag&gt;');
		expect(email.text).toContain('<script>alert(1)</script>');
	});

	it('names the provider, or says "your provider" when none is linked yet', () => {
		expect(providerSignInEmail('Ada', ['Contoso Entra'], 'https://x.test/login').text).toContain(
			'Contoso Entra'
		);
		expect(providerInvitationEmail('Ada', 'Grace', [], 'https://x.test/login').text).toContain(
			'sign-in provider'
		);
	});
});

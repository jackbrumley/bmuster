/**
 * Every email BMuster sends, from one template (SPEC-EMAIL E7): a plain text
 * part and an HTML part built from the same blocks, so they always say the
 * same thing. The HTML is a single light card in BMuster's colours with
 * inline styles only: no images, no remote content, no tracking pixels and
 * no rewritten links. Everything put into it is escaped.
 */
export type RenderedEmail = { subject: string; text: string; html: string };

type Block =
	| { kind: 'paragraph'; text: string }
	| { kind: 'facts'; rows: readonly { label: string; value: string }[] }
	| { kind: 'button'; label: string; url: string };

type EmailContent = {
	subject: string;
	heading: string;
	blocks: readonly Block[];
	/** Why the person is getting this email. */
	footer: string;
};

const BRAND = '#46720e';
const TEXT = '#161d14';
const MUTED = '#657061';
const SURFACE = '#f4f7f2';
const CARD = '#ffffff';
const BORDER = '#dfe4dc';
const FONT = "-apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

function escapeHtml(value: string): string {
	return value
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
		.replaceAll('"', '&quot;')
		.replaceAll("'", '&#39;');
}

function textBlock(block: Block): string {
	switch (block.kind) {
		case 'paragraph':
			return block.text;
		case 'facts':
			return block.rows.map((row) => `${row.label}: ${row.value}`).join('\n');
		case 'button':
			return `${block.label}:\n${block.url}`;
	}
}

function htmlBlock(block: Block): string {
	switch (block.kind) {
		case 'paragraph':
			return `<p style="margin:0 0 16px;font-size:15px;line-height:1.5;color:${TEXT}">${escapeHtml(block.text)}</p>`;
		case 'facts':
			return `<table role="presentation" style="margin:0 0 16px;border-collapse:collapse;font-size:14px">${block.rows
				.map(
					(row) =>
						`<tr><td style="padding:4px 16px 4px 0;color:${MUTED};vertical-align:top">${escapeHtml(row.label)}</td><td style="padding:4px 0;color:${TEXT}">${escapeHtml(row.value)}</td></tr>`
				)
				.join('')}</table>`;
		case 'button':
			return `<p style="margin:8px 0 16px"><a href="${escapeHtml(block.url)}" style="display:inline-block;padding:12px 24px;border-radius:999px;background:${BRAND};color:#ffffff;font-weight:600;font-size:15px;text-decoration:none">${escapeHtml(block.label)}</a></p><p style="margin:0 0 16px;font-size:13px;line-height:1.5;color:${MUTED}">If the button does not work, open this address:<br><span style="word-break:break-all">${escapeHtml(block.url)}</span></p>`;
	}
}

export function renderEmail(content: EmailContent): RenderedEmail {
	const text = [
		content.heading,
		'',
		...content.blocks.flatMap((block) => [textBlock(block), '']),
		'--',
		content.footer
	].join('\n');
	const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escapeHtml(content.subject)}</title></head><body style="margin:0;padding:24px 12px;background:${SURFACE};font-family:${FONT}"><table role="presentation" width="100%" style="border-collapse:collapse"><tr><td align="center"><table role="presentation" width="100%" style="max-width:520px;border-collapse:collapse;background:${CARD};border:1px solid ${BORDER};border-radius:16px"><tr><td style="padding:28px 28px 8px"><p style="margin:0 0 20px;font-size:18px;font-weight:700;color:${BRAND}">BMuster</p><h1 style="margin:0 0 16px;font-size:20px;line-height:1.3;color:${TEXT}">${escapeHtml(content.heading)}</h1>${content.blocks.map(htmlBlock).join('')}</td></tr><tr><td style="padding:16px 28px 24px;border-top:1px solid ${BORDER};font-size:12px;line-height:1.5;color:${MUTED}">${escapeHtml(content.footer)}</td></tr></table></td></tr></table></body></html>`;
	return { subject: content.subject, text, html };
}

/** The test email from Settings → Email (E2). */
export function testEmail(sentBy: string): RenderedEmail {
	return renderEmail({
		subject: 'BMuster test email',
		heading: 'Email works',
		blocks: [
			{
				kind: 'paragraph',
				text: 'This is a test email from BMuster. If you can read it, password resets, invitations and notifications can reach you.'
			}
		],
		footer: `Sent because ${sentBy} pressed Send a test email in Settings → Email.`
	});
}

/** E4: a single-use link to set a new password. */
export function passwordResetEmail(name: string, url: string, minutes: number): RenderedEmail {
	return renderEmail({
		subject: 'Reset your BMuster password',
		heading: 'Reset your password',
		blocks: [
			{
				kind: 'paragraph',
				text: `Hello ${name}. Someone asked to reset the password of your BMuster account. If it was you, choose a new password with this link. It works once, for ${minutes} minutes.`
			},
			{ kind: 'button', label: 'Choose a new password', url }
		],
		footer:
			'If you did not ask for this, ignore this email: your password stays as it is. Someone else typed your address on the sign-in page.'
	});
}

/** "Microsoft Entra or Authentik", or a general phrase while the person has linked none. */
function providerWords(providers: readonly string[]): string {
	return providers.length === 0 ? 'your organisation’s sign-in provider' : providers.join(' or ');
}

/** E4: someone who signs in through a provider asked for a password reset. */
export function providerSignInEmail(name: string, providers: string[], url: string): RenderedEmail {
	return renderEmail({
		subject: 'How to sign in to BMuster',
		heading: 'You sign in with your provider',
		blocks: [
			{
				kind: 'paragraph',
				text: `Hello ${name}. Someone asked to reset the password of your BMuster account, but your account has no BMuster password: you sign in with ${providerWords(providers)}. On the sign-in page, choose Continue with your provider. If you cannot sign in there, ask your provider's administrator.`
			},
			{ kind: 'button', label: 'Open the sign-in page', url }
		],
		footer:
			'If you did not ask for this, ignore this email. Nothing about your account has changed.'
	});
}

/** E5: an invitation to set a password, from an admin. */
export function invitationEmail(
	name: string,
	invitedBy: string,
	url: string,
	days: number
): RenderedEmail {
	return renderEmail({
		subject: `${invitedBy} invited you to BMuster`,
		heading: 'You are invited to BMuster',
		blocks: [
			{
				kind: 'paragraph',
				text: `Hello ${name}. ${invitedBy} has given you an account on BMuster. Choose a password with this link to start. It works once, for ${days} days.`
			},
			{ kind: 'button', label: 'Choose your password', url }
		],
		footer: 'You are getting this because a BMuster admin added you as a user.'
	});
}

/** E5: an account that signs in through a provider; there is no password to set. */
export function providerInvitationEmail(
	name: string,
	invitedBy: string,
	providers: string[],
	url: string
): RenderedEmail {
	return renderEmail({
		subject: `${invitedBy} invited you to BMuster`,
		heading: 'You are invited to BMuster',
		blocks: [
			{
				kind: 'paragraph',
				text: `Hello ${name}. ${invitedBy} has given you an account on BMuster. You sign in with ${providerWords(providers)}, using this email address: on the sign-in page, choose Continue with your provider.`
			},
			{ kind: 'button', label: 'Open the sign-in page', url }
		],
		footer: 'You are getting this because a BMuster admin added you as a user.'
	});
}

/** E6: one event, for the people a notification rule names. */
export function notificationEmail(content: {
	subject: string;
	heading: string;
	summary: string;
	facts: readonly { label: string; value: string }[];
	url: string;
	ruleDescription: string;
}): RenderedEmail {
	return renderEmail({
		subject: content.subject,
		heading: content.heading,
		blocks: [
			{ kind: 'paragraph', text: content.summary },
			{ kind: 'facts', rows: content.facts },
			{ kind: 'button', label: 'Open BMuster', url: content.url }
		],
		footer: `You are getting this because of the notification rule "${content.ruleDescription}". An admin can change it in Settings → Notifications.`
	});
}

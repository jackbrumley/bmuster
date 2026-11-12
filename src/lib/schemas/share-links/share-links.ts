/**
 * Share-link requests and replies (SPEC-SHARE-LINKS): the console's API and
 * the guest page's.
 */
import { z } from 'zod';
import { DESKTOP_MODES } from '#lib/domain/sessions/session.ts';
import {
	GUEST_COMPANY_MAX_LENGTH,
	GUEST_NAME_MAX_LENGTH,
	RECIPIENT_MAX_LENGTH,
	SHARE_DURATIONS,
	SHARE_LINK_PERMISSIONS
} from '#lib/domain/share-links/share-links.ts';

/** Control characters would let a label fake a line on the machine's notice or in Activity. */
const CONTROL_CHARACTERS = /\p{Cc}/u;

/** One line of plain text, trimmed, at most `max` characters; `min` 0 allows it empty. */
function plainLine(min: 0 | 1, max: number, emptyMessage: string) {
	return z
		.string()
		.trim()
		.min(min, emptyMessage)
		.max(max, `At most ${max} characters.`)
		.refine((text) => !CONTROL_CHARACTERS.test(text), 'Use plain text on one line.');
}

/** `POST /api/machines/[id]/share-links`. Watching is always on; the ticks add to it. */
export const createShareLinkRequestSchema = z.object({
	recipient: plainLine(1, RECIPIENT_MAX_LENGTH, 'Say who the link is for.'),
	duration: z.enum(SHARE_DURATIONS, 'Choose how long the link lasts.'),
	control: z.boolean(),
	files: z.boolean()
});

export type CreateShareLinkRequest = z.infer<typeof createShareLinkRequestSchema>;

/** Stored in `share_links.permissions`: never empty, always with watching. */
export const storedSharePermissionsSchema = z
	.array(z.enum(SHARE_LINK_PERMISSIONS))
	.refine((list) => list.includes('desktop-view') && new Set(list).size === list.length);

const shareLinkViewSchema = z.object({
	id: z.uuid(),
	machineId: z.string(),
	machineName: z.string(),
	recipient: z.string(),
	permissions: z.array(z.enum(SHARE_LINK_PERMISSIONS)),
	createdByName: z.string(),
	createdIso: z.iso.datetime(),
	expiresIso: z.iso.datetime(),
	lastUse: z.discriminatedUnion('kind', [
		z.object({ kind: z.literal('never') }),
		z.object({
			kind: z.literal('used'),
			name: z.string(),
			company: z.string(),
			address: z.string(),
			atIso: z.iso.datetime()
		})
	])
});

/** The new link and its address, shown once. */
export const createShareLinkReplySchema = z.object({
	link: shareLinkViewSchema,
	url: z.string().min(1)
});

/** A machine's active links, and what this person may tick when making one. */
export const machineShareLinksReplySchema = z.object({
	links: z.array(shareLinkViewSchema),
	canTick: z.object({ control: z.boolean(), files: z.boolean() })
});

export const endShareLinkReplySchema = z.object({ ended: z.literal(true) });

/** Who the guest says they are, typed on the guest page (SPEC-SHARE-LINKS D17). */
export const guestIdentitySchema = z.object({
	name: plainLine(1, GUEST_NAME_MAX_LENGTH, 'Type your name.'),
	company: plainLine(0, GUEST_COMPANY_MAX_LENGTH, '')
});

/** `POST /s/[token]/session`: the guest, who they say they are, asks to watch or control. */
export const guestSessionRequestSchema = guestIdentitySchema.extend({
	mode: z.enum(DESKTOP_MODES)
});

/** `POST /s/[token]/browser-ticket`: the link's own running session. */
export const guestTicketRequestSchema = z.object({ sessionId: z.uuid() });

/**
 * `GET /s/[token]/status`: the page polls it to end itself when the link ends. An ended
 * link gets the guard's plain 404 instead.
 */
export const guestStatusReplySchema = z.object({
	kind: z.literal('active'),
	expiresIso: z.iso.datetime()
});

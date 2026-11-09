import { z } from 'zod';
import type { DisplayReport } from '#lib/domain/machines/display-report.ts';

/** The inventory's display report (SPEC-AGENT-LOGS 3); the Rust side is protocol/src/display.rs. */
const word = z.string().max(255);

const seatSchema = z.discriminatedUnion('kind', [
	z.object({ kind: z.literal('none') }),
	z.object({
		kind: z.literal('active'),
		sessionType: word,
		class: word,
		desktop: word,
		state: word,
		lockedHint: z.discriminatedUnion('kind', [
			z.object({ kind: z.literal('unknown') }),
			z.object({ kind: z.literal('known'), locked: z.boolean() })
		])
	})
]);

const cardSchema = z.object({
	name: word,
	driver: word,
	kms: z.boolean(),
	connectors: z.array(z.object({ name: word, modes: z.array(z.string().max(64)).max(256) })).max(32)
});

export const displayReportSchema = z
	.discriminatedUnion('kind', [
		z.object({
			kind: z.literal('linux'),
			seat: seatSchema,
			cards: z.array(cardSchema).max(32),
			uinput: z.object({ device: z.boolean(), module: z.boolean() }),
			nvidiaModeset: z.discriminatedUnion('kind', [
				z.object({ kind: z.literal('absent') }),
				z.object({ kind: z.literal('present'), value: word })
			]),
			programs: z.object({
				xdgDesktopPortal: z.boolean(),
				gstreamer: z.boolean(),
				pipewiresrc: z.boolean()
			}),
			kernel: word,
			agentVersion: word,
			launcherVersion: z.discriminatedUnion('kind', [
				z.object({ kind: z.literal('none') }),
				z.object({ kind: z.literal('known'), version: word })
			])
		}),
		z.object({
			kind: z.literal('windows'),
			console: z.discriminatedUnion('kind', [
				z.object({ kind: z.literal('none') }),
				z.object({ kind: z.literal('user'), name: word })
			])
		}),
		z.object({ kind: z.literal('unsupported') }),
		z.object({ kind: z.literal('unreported') })
	])
	.default({ kind: 'unreported' }) satisfies z.ZodType<DisplayReport>;

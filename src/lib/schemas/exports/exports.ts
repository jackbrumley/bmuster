import { z } from 'zod';
import {
	MACHINE_FILTERS,
	MACHINE_SORT_KEYS,
	type MachineOrder
} from '#lib/domain/machines/machine-row.ts';

/**
 * Query parameters of the list exports (SPEC-CSV-EXPORT). They only narrow
 * what the access check already allows; none widens it.
 */

/** GET /api/exports/machines: the page's search and filter, and the table's sort (none in Cards view). */
export const machinesExportQuerySchema = z
	.object({
		search: z.string().max(200).default(''),
		filter: z.enum(MACHINE_FILTERS).default('all'),
		sort: z.enum(MACHINE_SORT_KEYS).optional(),
		direction: z.enum(['asc', 'desc']).default('asc')
	})
	.transform(({ search, filter, sort, direction }) => ({
		search,
		filter,
		order:
			sort === undefined
				? ({ kind: 'list' } satisfies MachineOrder)
				: ({ kind: 'column', column: sort, direction } satisfies MachineOrder)
	}));

export type MachinesExportQuery = z.output<typeof machinesExportQuerySchema>;

function isTimeZone(name: string): boolean {
	try {
		new Intl.DateTimeFormat('en', { timeZone: name });
		return true;
	} catch {
		return false;
	}
}

/** One end of a date range: open, or an exact time. */
type RangeEnd = { kind: 'open' } | { kind: 'at'; ms: number };

const rangeEndSchema = z.iso
	.datetime({ offset: true })
	.optional()
	.transform((iso): RangeEnd =>
		iso === undefined ? { kind: 'open' } : { kind: 'at', ms: Date.parse(iso) }
	);

/** GET /api/exports/activity: the viewer's time zone for the local time column, and an optional range. */
export const activityExportQuerySchema = z.object({
	timeZone: z.string().max(64).refine(isTimeZone, 'Not a known time zone.').default('UTC'),
	from: rangeEndSchema,
	to: rangeEndSchema
});

export type ActivityExportQuery = z.output<typeof activityExportQuerySchema>;

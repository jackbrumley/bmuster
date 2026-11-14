/** Fixtures for `route-guard-required` (scripts/hygiene/route-guards.ts). */
import { checkRouteGuards } from '../../../../scripts/hygiene/route-guards.ts';
import { reported, type RuleFixture } from './harness.ts';

const run = (relPath: string, content: string) => () =>
	reported((reporter) => {
		checkRouteGuards(relPath, content, reporter.violation);
	});

const ENDPOINT = 'src/routes/api/users/+server.ts';
const PAGE_SERVER = 'src/routes/(console)/users/+page.server.ts';
const UNIVERSAL = 'src/routes/(console)/users/+page.ts';
const DIAGNOSTICS = 'src/routes/api/diagnostics/machines/+server.ts';
const GUEST = 'src/routes/s/[token]/session/+server.ts';
const TOKEN = 'src/routes/oauth/token/+server.ts';
const METADATA = 'src/routes/.well-known/oauth-authorization-server/+server.ts';
const CONSENT = 'src/routes/oauth/authorize/+page.server.ts';
const MCP = 'src/routes/mcp/+server.ts';

export const routeGuardFixtures: readonly RuleFixture[] = [
	{
		rule: 'route-guard-required',
		bad: run(ENDPOINT, 'export const GET = () => Response.json({ users: [] });'),
		good: run(
			ENDPOINT,
			"import { route } from '#lib/server/guards/route.ts';\nexport const GET = route.admin(() => Response.json({ users: [] }));"
		)
	},
	{
		rule: 'route-guard-required',
		bad: run(
			ENDPOINT,
			"import { route } from '#lib/server/guards/route.ts';\nexport const GET = route.anyone(() => Response.json({}));"
		),
		good: run(
			ENDPOINT,
			"import { route } from '#lib/server/guards/route.ts';\nexport const GET = route.public(() => Response.json({}));"
		)
	},
	{
		rule: 'route-guard-required',
		bad: run(
			PAGE_SERVER,
			"import { page } from '#lib/server/guards/page.ts';\nexport const load = page.admin(() => ({}));\nexport const actions = { default: async () => ({}) };"
		),
		good: run(
			PAGE_SERVER,
			"import { page } from '#lib/server/guards/page.ts';\nexport const load = page.admin(() => ({}));\nexport const actions = { default: page.admin(async () => ({})) };"
		)
	},
	{
		rule: 'route-guard-required',
		bad: run(UNIVERSAL, 'export const load = () => ({ users: [] });'),
		good: run(UNIVERSAL, 'export const ssr = true;')
	},
	// SPEC-AGENT-LOGS 4: tokens are read-only by construction.
	{
		rule: 'route-guard-required',
		bad: run(
			DIAGNOSTICS,
			"import { route } from '#lib/server/guards/route.ts';\nexport const POST = route.diagnostics(() => Response.json({}));"
		),
		good: run(
			DIAGNOSTICS,
			"import { route } from '#lib/server/guards/route.ts';\nexport const GET = route.diagnostics(() => Response.json({}));"
		)
	},
	{
		rule: 'route-guard-required',
		bad: run(
			ENDPOINT,
			"import { route } from '#lib/server/guards/route.ts';\nexport const GET = route.diagnostics(() => Response.json({}));"
		),
		good: run(
			ENDPOINT,
			"import { route } from '#lib/server/guards/route.ts';\nexport const GET = route.admin(() => Response.json({}));"
		)
	},
	{
		rule: 'route-guard-required',
		bad: run(
			ENDPOINT,
			"import { route } from '#lib/server/guards/route.ts';\nexport const POST = route.guest(() => Response.json({}));"
		),
		good: run(
			GUEST,
			"import { route } from '#lib/server/guards/route.ts';\nexport const POST = route.guest(() => Response.json({}));"
		)
	},
	// SPEC-MCP: the authorisation server and /mcp each have a guard of their own, kept to their paths.
	{
		rule: 'route-guard-required',
		bad: run(
			ENDPOINT,
			"import { route } from '#lib/server/guards/route.ts';\nexport const POST = route.oauth(() => Response.json({}));"
		),
		good: run(
			TOKEN,
			"import { route } from '#lib/server/guards/route.ts';\nexport const POST = route.oauth(() => Response.json({}));"
		)
	},
	{
		rule: 'route-guard-required',
		bad: run(
			'src/routes/api/well-known/+server.ts',
			"import { route } from '#lib/server/guards/route.ts';\nexport const GET = route.oauth(() => Response.json({}));"
		),
		good: run(
			METADATA,
			"import { route } from '#lib/server/guards/route.ts';\nexport const GET = route.oauth(() => Response.json({}));"
		)
	},
	{
		rule: 'route-guard-required',
		bad: run(
			PAGE_SERVER,
			"import { page } from '#lib/server/guards/page.ts';\nexport const load = page.oauth(() => ({}));"
		),
		good: run(
			CONSENT,
			"import { page } from '#lib/server/guards/page.ts';\nexport const load = page.oauth(() => ({}));"
		)
	},
	{
		rule: 'route-guard-required',
		bad: run(
			ENDPOINT,
			"import { route } from '#lib/server/guards/route.ts';\nexport const POST = route.mcp(() => Response.json({}));"
		),
		good: run(
			MCP,
			"import { route } from '#lib/server/guards/route.ts';\nexport const POST = route.mcp(() => Response.json({}));"
		)
	}
];

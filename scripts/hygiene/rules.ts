/**
 * The hygiene rule registry: the one source of truth for every rule id the
 * hygiene check reports (AGENTS.md §16).
 *
 * Each rule says whether it fails the run (`violation`) or only warns
 * (`warning`), why it exists, how to fix a finding, and the AGENTS.md
 * section it enforces. `Reporter.violation` / `Reporter.warning` only accept
 * ids registered here with the matching severity, so a new rule cannot be
 * reported until it is documented. The rule index in AGENTS.md is generated
 * from this list (`npm run hygiene:docs`), and every rule has a fixture in
 * tests/unit/hygiene/ that proves it still fires.
 */

export type Severity = 'violation' | 'warning';

export interface RuleDefinition {
	readonly severity: Severity;
	/** AGENTS.md section the rule enforces, e.g. `4`. */
	readonly section: string;
	/** One line: what goes wrong without the rule. */
	readonly why: string;
	/** One line: how to fix a finding. */
	readonly fix: string;
}

export const HYGIENE_RULES = {
	// File layout (scripts/hygiene/file-layout.ts)
	naming: {
		severity: 'violation',
		section: '2',
		why: 'File and folder names are kebab-case so imports work on case-sensitive Linux builds.',
		fix: 'Rename the file or folder to kebab-case (SvelteKit route files and `[param]` folders are exempt).'
	},
	'css-placement': {
		severity: 'violation',
		section: '4',
		why: 'Global CSS lives in two files; stray stylesheets leak styles across components.',
		fix: 'Move the styles into the component’s scoped `<style>` block (global rules go in src/app.css).'
	},
	'style-module-file': {
		severity: 'violation',
		section: '4',
		why: '`*-styles.ts` modules hold style strings the token checks cannot see.',
		fix: 'Move the styles into the component’s scoped `<style>` block.'
	},
	artefact: {
		severity: 'violation',
		section: '2',
		why: 'Backup and temporary files (`backup`, `temp`, `tmp` or `old` in the name) in src/ get shipped and confuse readers.',
		fix: 'Delete the file; git history is the backup.'
	},
	'lib-root-file-forbidden': {
		severity: 'violation',
		section: '2',
		why: 'src/lib/ holds only the area folders, so loose modules or new top-level folders leave nobody sure where a file belongs.',
		fix: 'Move the file into its folder (server/, domain/, schemas/, ui/, shell/, runes/ or utils/) and update its imports.'
	},
	'file-size': {
		severity: 'violation',
		section: '7',
		why: 'Files over 1000 lines are too big to read and review as one unit.',
		fix: 'Split the file along functional boundaries (sub-components, helpers, services); never squash lines.'
	},
	'file-size-soft': {
		severity: 'warning',
		section: '7',
		why: 'Files over 600 lines are the signal to plan a split before they reach the hard limit.',
		fix: 'Plan and make a split into sub-components, helpers or services.'
	},
	'git-naming-case': {
		severity: 'violation',
		section: '2',
		why: 'A case-only rename git did not record passes on a case-insensitive disk but breaks Linux builds.',
		fix: 'Rename the tracked path to kebab-case with `git mv`.'
	},
	'git-naming-case-failed': {
		severity: 'violation',
		section: '2',
		why: 'Tracked file names cannot be checked when `git ls-files` fails.',
		fix: 'Run hygiene inside the git working tree and make sure git works.'
	},
	'svelte-parse-error': {
		severity: 'violation',
		section: '16',
		why: 'A component svelte/compiler cannot parse is skipped by every other rule.',
		fix: 'Fix the syntax error the message names (svelte-check shows it too).'
	},

	// Code standards (scripts/hygiene/code-standards.ts)
	'lint-bypass-forbidden': {
		severity: 'violation',
		section: '7',
		why: 'Bypass pragmas (eslint, TypeScript, Svelte) hide real problems from the checks.',
		fix: 'Delete the pragma and fix the code so it passes natively.'
	},
	'any-type-forbidden': {
		severity: 'violation',
		section: '7',
		why: '`any` switches type checking off for everything it touches.',
		fix: 'Use `unknown` and narrow it, or write the specific type.'
	},
	'inline-dependencies-forbidden': {
		severity: 'violation',
		section: '7',
		why: '`npm:`, `jsr:` and URL imports bypass package.json, so versions and audits drift.',
		fix: 'Add the package to package.json with an exact version and import it by name.'
	},
	'australian-spelling-violation': {
		severity: 'violation',
		section: '7',
		why: 'BMuster is written in Australian English, in the UI and in code.',
		fix: 'Spell it `organisation` (with an s).'
	},
	'redirect-cookie-mutation-forbidden': {
		severity: 'violation',
		section: '6',
		why: 'A `Response.redirect` has immutable headers, so setting a cookie on it throws at runtime.',
		fix: 'Set cookies with `event.cookies` and redirect with `redirect()` from @sveltejs/kit.'
	},
	'redirect-header-mutation-forbidden': {
		severity: 'violation',
		section: '6',
		why: 'A `Response.redirect` has immutable headers, so changing them throws at runtime.',
		fix: 'Use `redirect()` from @sveltejs/kit, or build a `Response` with a Location header.'
	},
	'relative-dynamic-import-forbidden': {
		severity: 'violation',
		section: '7',
		why: 'Relative dynamic imports make the server build evaluate the module graph at runtime.',
		fix: 'Use a static top-level import (`#lib/…`).'
	},
	'snake-case-url-query-parameter-forbidden': {
		severity: 'violation',
		section: '10',
		why: 'BMuster’s own query parameters are camelCase; mixed casing leads to dual-case fallbacks.',
		fix: 'Rename the parameter to camelCase everywhere (names fixed by an outside protocol go in externalProtocolQueryParams).'
	},
	'raw-html-forbidden': {
		severity: 'violation',
		section: '7',
		why: '`{@html}` renders unescaped HTML: a cross-site scripting risk in a tool that controls other computers.',
		fix: 'Render the content with components.'
	},
	'each-block-key-required': {
		severity: 'violation',
		section: '7',
		why: 'An unkeyed `{#each}` reuses rows by position, so row state jumps when the list changes.',
		fix: 'Key the block: `{#each items as item (item.id)}`.'
	},

	// Styling (scripts/hygiene/styling.ts)
	'important-forbidden': {
		severity: 'violation',
		section: '4',
		why: '`!important` overrides the cascade and hides specificity problems.',
		fix: 'Fix the selector or the structure instead.'
	},
	'raw-emoji-forbidden': {
		severity: 'violation',
		section: '5',
		why: 'Raw emoji render differently on every operating system and look unprofessional.',
		fix: 'Use a Tabler icon from @tabler/icons-svelte-runes.'
	},
	'hardcoded-color-forbidden': {
		severity: 'violation',
		section: '4',
		why: 'Literal colours ignore the theme (dark mode) and drift from the palette.',
		fix: 'Use a design-token variable, `var(--…)`; add a `light-dark()` token to src/lib/ui/design-tokens.css if none fits.'
	},
	'style-token-required': {
		severity: 'violation',
		section: '4',
		why: 'Spacing, type and shadow values come from the token scale so screens stay consistent.',
		fix: 'Use `var(--…)` (or 0, %, fr, auto or a keyword).'
	},

	// Standard controls (scripts/hygiene/raw-controls.ts)
	'raw-button-reason-required': {
		severity: 'violation',
		section: '12',
		why: 'Raw `<button>`s skip the standard Button’s look, size and focus behaviour.',
		fix: 'Use `<Button>` (src/lib/ui/button.svelte), or for a specialised widget add `data-raw-button="<reason>"` from the list in raw-controls.ts.'
	},
	'raw-input-reason-required': {
		severity: 'violation',
		section: '12',
		why: 'Raw fields skip the standard field’s label, error slot and phone sizing.',
		fix: 'Use `<TextField>` (src/lib/ui/text-field.svelte), or for a specialised widget add `data-raw-input="<reason>"` from the list in raw-controls.ts.'
	},

	// Destructive requests (scripts/hygiene/destructive-confirmation.ts)
	'destructive-request-confirmation': {
		severity: 'violation',
		section: '12',
		why: 'A delete, remove or revoke sent without a confirmation dialog is one stray tap from losing data or access.',
		fix: 'Confirm with `confirmAction()`, or list a caller-confirmed helper in DESTRUCTIVE_REQUEST_EXEMPTIONS.'
	},

	// Route guards (scripts/hygiene/route-guards.ts)
	'route-guard-required': {
		severity: 'violation',
		section: '11',
		why: 'A route handler not built by a guard runs without checking who is asking.',
		fix: 'Export it as `route.<public|user|admin|agent>(…)` or `page.<public|user|admin>(…)` from src/lib/server/guards/; `route.diagnostics(…)` only for GET under src/routes/api/diagnostics/.'
	},

	// Server boundary (scripts/hygiene/server-boundary.ts)
	'server-imports-app-modules-forbidden': {
		severity: 'violation',
		section: '6',
		why: 'src/lib/server/** runs outside Vite (scripts, tests), where `$app/*` and `$env/*` do not exist.',
		fix: 'Take what the module needs as a parameter from the route or hook.'
	},
	'browser-imports-server-forbidden': {
		severity: 'violation',
		section: '6',
		why: 'Code the browser loads that imports from src/lib/server/** (even a type) drifts from what the server sends and is one import away from bundling server code.',
		fix: 'Declare the shape in src/lib/domain/<area>/ and import it from there on both sides; name a server-only route helper *.server.ts.'
	},

	// UI components (scripts/hygiene/ui-components.ts)
	'browser-native-dialog-forbidden': {
		severity: 'violation',
		section: '12',
		why: '`alert`, `confirm` and `prompt` block the page and look different on every device.',
		fix: 'Show a toast for results and use `confirmAction()` for anything destructive.'
	},
	'loading-text-forbidden': {
		severity: 'violation',
		section: '12',
		why: 'A page’s own “Loading…” text or hand-made spinner looks stuck on a long wait and differs on every screen.',
		fix: 'Cover the block with `<LoadingVeil>` (src/lib/ui/loading-veil.svelte), or put `<RadarSpinner size="small" />` in the button or row.'
	},

	// Input font size (scripts/hygiene/input-font-size.ts)
	'input-font-size-ios-zoom': {
		severity: 'violation',
		section: '4',
		why: 'iOS zooms the page when a text box under 16px is focused (inputs, textareas, selects, contenteditable, xterm.js), cropping the phone layout.',
		fix: 'Size text boxes with `var(--text-base)` or a larger token (never `inherit`, `em` or `calc()`), and keep the 16px base rule for text boxes in src/app.css.'
	},

	// Page frames (scripts/hygiene/page-frames.ts)
	'page-frame-required': {
		severity: 'violation',
		section: '4',
		why: 'A page outside ShellFrame and PublicPage lays out its own edges, so on phones it can sit under the status bar, notch or home bar.',
		fix: 'Put the page under the (console) layout (ShellFrame), or render it in `<PublicPage>` (#lib/shell/public-page.svelte).'
	},
	'page-root-container-forbidden': {
		severity: 'violation',
		section: '4',
		why: 'A full-screen-height container outside the two frames is a page building a frame of its own, without the safe-area insets.',
		fix: 'Drop the container; only ShellFrame and PublicPage size themselves to the screen.'
	},
	// Page structure (scripts/hygiene/page-structure.ts)
	'route-card-look-forbidden': {
		severity: 'violation',
		section: '4',
		why: 'A page that draws its own card (card radius with a border or shadow, or the card shadow) drifts from every other card in the console.',
		fix: 'Use `<Panel>` or `<ListCard>` from src/lib/ui; change the shared component if every card needs the change.'
	},
	'page-header-required': {
		severity: 'violation',
		section: '4',
		why: 'A console page without PageHeader puts its title somewhere else, so pages jump about when moving between them.',
		fix: 'Start the page with `<PageHeader>` (#lib/ui/page-header.svelte), or list its folder in PAGE_HEADER_FROM_LAYOUT with the reason.'
	},
	'fixed-edge-safe-area': {
		severity: 'violation',
		section: '4',
		why: 'A fixed element pinned to the top or bottom of the screen sits under the status bar, notch or home bar on phones.',
		fix: 'Offset it by the inset: `top: calc(<gap> + var(--safe-top))`, `bottom: calc(<gap> + var(--safe-bottom))`.'
	},

	// Corner radius (scripts/hygiene/border-radius.ts)
	'border-radius-token-required': {
		severity: 'violation',
		section: '4',
		why: 'Corner radius is picked by role so buttons, fields, cards and modals match on every screen.',
		fix: 'Use `var(--radius-<role>)` (pill, control, card, modal, inner, round) or 0.'
	},

	// Client fetch (scripts/hygiene/client-fetch.ts)
	'client-raw-fetch-forbidden': {
		severity: 'violation',
		section: '6',
		why: 'Browser code talks to the server through one client that handles headers, errors, expiry and the reply contract.',
		fix: 'Use the API client in src/lib/utils/api-client.ts with a zod reply contract.'
	},

	// Environment variables (scripts/hygiene/env-vars.ts)
	'env-var-registered': {
		severity: 'violation',
		section: '9',
		why: '.env.example is the list of settings an installer fills in, so it must match what env.ts reads.',
		fix: 'Add the variable (with a comment) to .env.example, or remove the entry nothing reads.'
	},
	'env-direct-access-forbidden': {
		severity: 'violation',
		section: '9',
		why: 'Reading process.env outside env.ts skips the fail-hard start-up check.',
		fix: 'Add the value to `env` in src/lib/server/env.ts and read it from there.'
	},

	// Casts (scripts/hygiene/double-cast.ts)
	'double-cast-forbidden': {
		severity: 'violation',
		section: '7',
		why: 'A cast through `unknown` converts anything into anything and switches type checking off.',
		fix: 'Type the value properly: a generic, a type guard, narrowing or a zod parse at a trust boundary.'
	},

	// Project files (scripts/hygiene/project-files.ts, rule-index.ts)
	'claude-symlink': {
		severity: 'violation',
		section: '16',
		why: 'CLAUDE.md links to AGENTS.md so every agent reads the same rules.',
		fix: 'Run `ln -sf AGENTS.md CLAUDE.md`.'
	},
	'hygiene-docs-current': {
		severity: 'violation',
		section: '16',
		why: 'The hygiene rule index in AGENTS.md is generated from the rule registry and must match it.',
		fix: 'Run `npm run hygiene:docs`.'
	}
} as const satisfies Readonly<Record<string, RuleDefinition>>;

export type RuleId = keyof typeof HYGIENE_RULES;

/** The ids registered with a given severity. */
export type RuleIdOf<S extends Severity> = {
	[Id in RuleId]: (typeof HYGIENE_RULES)[Id]['severity'] extends S ? Id : never;
}[RuleId];

export const RULE_IDS: readonly RuleId[] = Object.keys(HYGIENE_RULES).filter(
	(id): id is RuleId => id in HYGIENE_RULES
);

/** The pointer printed after each finding, e.g. `AGENTS.md §4`. */
export function rulePointer(id: RuleId): string {
	return `AGENTS.md §${HYGIENE_RULES[id].section}`;
}

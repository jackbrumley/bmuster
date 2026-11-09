# BMuster: Agent Guidelines

Rules for every AI coding agent working in this repository. `CLAUDE.md` is a link to this file. Written in Australian English.

BMuster is a self-hosted remote desktop, terminal and inventory tool: one SvelteKit server (web console, API, relay) and one Rust agent per machine. Its rules come from the Wannon Digital portal, trimmed for a single-tenant, open-source (AGPLv3) project. Background: `docs/concept.md`, `docs/engineering-plan.md`, `docs/access-and-sign-in.md`.

---

# 🚨 CRITICAL: NEVER WIPE, DROP OR RE-INITIALISE A DATABASE

> - Agents never delete a database file, run `DROP TABLE` / `TRUNCATE`, or run any reset or seed command.
> - Agents write schema files and queries in code, then stop. The developer generates and applies migrations that need a prompt.
> - **The one exception, local only:** agents may run `npm run db:migrate` to apply committed, additive migrations to the local development database.

# 🚨 CRITICAL: START FROM THE LATEST CODE

> 1. Before changing anything, ask the developer whether they have pulled the latest code.
> 2. Run `git fetch`, then `git status -sb` and `git rev-list --left-right --count HEAD...@{upstream}`.
> 3. **Behind** with a clean tree: `git pull --ff-only`. Behind with uncommitted changes: stop and ask; never stash, reset or discard them.
> 4. **Diverged:** stop and tell the developer before writing code.
> 5. **Up to date:** say so in one line and start.

# 🚨 CRITICAL: THIS TOOL CONTROLS OTHER PEOPLE'S COMPUTERS

> Whoever controls a BMuster server controls every enrolled machine. Any change to sign-in, sessions, access rules, enrolment, the agent channel or agent updates is security work: say so in the plan, and never weaken a check to make something work (Section 11).

---

## Core commands

Node ≥ 26, SvelteKit 3, Vite, `adapter-node`. Scripts under `scripts/` run with plain `node` (type stripping).

| Task                     | Command                                                  | Section |
| :----------------------- | :------------------------------------------------------- | :------ |
| Install                  | `npm install` (also installs the pre-push hook)          | —       |
| Dev server               | `npm run dev` (HTTPS, on the LAN for phone testing)      | —       |
| Verify everything        | `npm run verify` (`-- --fast`: no build)                 | 8       |
| Format                   | `npm run fmt`                                            | 8       |
| Lint                     | `npm run lint`                                           | 8       |
| Type check               | `npm run check`                                          | 8       |
| Hygiene                  | `npm run hygiene` (also dead code and duplication)       | 16      |
| Hygiene rule index       | `npm run hygiene:docs` (after adding or changing a rule) | 16      |
| Tests                    | `npm test`                                               | 15      |
| Build                    | `npm run build`                                          | —       |
| Generate migration       | `npm run db:generate < /dev/null` (additive only)        | 3       |
| Apply migrations (local) | `npm run db:migrate`                                     | 3       |

---

## 1. Plan, then implement

1. **Spec.** Anything bigger than a small fix gets a spec in `docs/specs/SPEC-<AREA>.md`: problem, acceptance criteria (each one testable, naming its test), schema changes, routes, security notes, open questions.
2. **Approval.** Present the spec, leading with open questions and anything touching sign-in, access, sessions or the agent. Write no code until the developer approves.
3. **Tests first.** Write the tests the acceptance criteria name and watch them fail for the right reason.
4. **Implement** under every rule in this file.
5. **`npm run verify` green.**
6. **Close the loop:** version bump and changelog entry (Section 8), spec marked `IMPLEMENTED (vX.Y.Z)` with "As built" notes where the build differs.

**Definition of Done**

- [ ] Every acceptance criterion has a passing test that names it.
- [ ] `npm run verify` is green. No bypass comments, loosened lint settings or new hygiene allowlist entries.
- [ ] Every screen works below 768px and on desktop, in light and dark themes.
- [ ] Access checks go through the access service (Section 11); nothing trusts the browser.
- [ ] Migrations are additive and generated, never hand-written (Section 3).
- [ ] Version, changelog and spec status updated.

---

## 2. Project structure

```
src/
  app.html  app.css  app.d.ts  hooks.server.ts  params.ts
  routes/               thin: validate, call a service, reply (Section 6)
    (console)/          pages inside the console frame
    login/              pages outside it (PublicPage)
    api/                JSON endpoints for the console
    agent/              endpoints and sockets for agents
  lib/
    server/             server-only code (Section 6)
      database/         connection.ts, schema.ts, schema/<area>.ts, migrations/
      services/<area>/  services and repositories
      guards/ hooks/ sockets/
      env.ts            the only reader of process.env
    domain/<area>/      browser-safe types and pure rules
    schemas/<area>/     zod request and reply contracts
    ui/                 tokens and shared components
    shell/              console frame, public page, navigation
    runes/              *.svelte.ts state helpers
    utils/              formatting, the one API client
scripts/                hygiene, verify, migrate
tests/                  unit/, ui/, hygiene fixtures
agent/                  Rust workspace: the program installed on each machine (Section 14)
docs/                   concept, plans, specs
```

- `src/lib/` holds only folders.
- File and folder names are kebab-case. Components are `kebab-case.svelte`.
- A component used by one route lives beside that route.
- UUID route parameters use a param matcher (`[id=uuid]`) once real ids land.

---

## 3. Database

- **SQLite with Drizzle** (`better-sqlite3`), WAL mode, foreign keys on. One file under `DATABASE_PATH`.
- **TypeScript first.** The schema lives in `src/lib/server/database/schema/<area>.ts`, re-exported by `schema.ts`. Tables are plural snake_case; TypeScript fields are camelCase (`casing: 'snake_case'`).
- **Ids** are `crypto.randomUUID()` text, made by the server.
- **Migrations** are generated by `npm run db:generate`, never hand-edited, and run at server start. Additive changes only. A data backfill is appended DML in the generated file. Dropping or renaming a column is a developer decision.
- **Repositories** own all SQL for their area and touch only their area's tables. Services take the database (or a transaction) as their first argument, so tests pass a fresh in-memory one; routes pass the server's `database` from `app-database.ts` and never build queries themselves.
- **Live figures** (CPU and memory every few seconds) stay in memory and stream to the browser; the database keeps snapshots, sessions, audit entries and down-sampled history.
- Times are stored as integer milliseconds (`mode: 'timestamp_ms'`) and sent as ISO strings.

---

## 4. Styling and tokens

- **Scoped `<style>` in each component.** Global CSS lives only in `src/app.css` (resets, focus) and `src/lib/ui/design-tokens.css`.
- **Tokens only** for colour, spacing (margin, padding, gap), font size, weight, family, letter-spacing, radius and shadow. Literals are fine for widths, heights, positions, grid tracks, 1–2px borders, z-index, opacity, line-height, durations, `%`, `fr` and viewport units.
- **Themes:** every colour token is `light-dark(<light>, <dark>)`. Never write a theme-specific rule in a component. The switch sets `data-theme` on `<html>`.
- **Surfaces:** page `--surface`; card, panel, bar `--surface-elevated`; modal and popover `--surface-overlay`; small tints `--surface-muted`.
- **Colour meaning:** `--brand` for actions and the current item; `--success`, `--warning`, `--danger` for status only.
- **Radius roles:** things you click are pills (`--radius-pill`); things you type into are boxes (`--radius-control`); cards `--radius-card`; modals `--radius-modal`; dots and avatars `--radius-round`.
- **Shared page blocks:** pages are built from `src/lib/ui`, never their own copies. Every console page starts with `PageHeader` (machine tabs take the machine layout's header); cards are `Panel`, bordered lists are `ListCard` with `ListRow`, link tabs are `TabNav`, pick-one pills are `ChipGroup` / `SegmentedControl`, empty and offline states are `EmptyState`, small uppercase headings are `SectionHeading`. `ShellFrame` spaces a page's blocks with `--gap-section`, so a page adds no outer margins. A route file never declares a card look (hygiene rules `route-card-look-forbidden`, `page-header-required`).
- **Page frames:** every console page renders inside `ShellFrame`, every other page inside `PublicPage`. Frames own the safe-area padding; a page never adds its own full-height root container. Anything `position: fixed` against an edge adds the matching `--safe-*` inset.
- **Mobile first:** design at phone width, then widen. Breakpoint for the sidebar layout: 900px. Text boxes (text inputs, textareas, selects, contenteditable, xterm's hidden textarea) are at least 16px (`--text-base`), because iOS zooms the page when a smaller one is focused; src/app.css sets that base, and a component may only make it larger. Helper text and labels beside a box can stay small. Touch targets are at least 40px.
- No `!important`.

---

## 5. Icons and emoji

- Icons come from `@tabler/icons-svelte-runes` only.
- No emoji anywhere in the UI or in code strings.

---

## 6. Architecture and boundaries

- **Thin routes** (under 200 lines): validate input with zod, call a service, reply. No SQL in routes.
- **Server boundary:** `src/lib/server/**` never imports `$app/*` or `$env/*`, so services run from scripts and tests. Browser code never imports server code, not even a type. Shared shapes live in `src/lib/domain/`.
- **One API client:** browser code never calls `fetch` itself. It goes through `src/lib/utils/api-client.ts` with a zod reply contract.
- **Links** go through `resolve()` from `$app/paths` with a route id, so every link is type-checked and BMuster can run under a sub-path.
- **Service areas:** `agents`, `sessions`, `inventory`, `users`, `auth`, `access`, `settings`, `audit`. Foundation areas (`settings`, `audit`) never import feature areas. No import cycles.
- **Server owns the run:** sessions, inventory scans and file transfers live on the server and the agent. Browsers are viewports: they subscribe, get a snapshot, and can leave and come back.
- **WebSockets:** browsers connect with a short-lived ticket from an authenticated request; agents connect with their own signed credential, never a cookie.

---

## 7. Coding style

- **TypeScript that Node runs directly:** no `enum`, no `namespace`, no constructor parameter properties. Use `.ts` extensions in imports, `import type`, and the `#lib/*` alias.
- **No `any`, no `as unknown as T`, no non-null `x!`.** Parse untrusted input with zod.
- **No bypasses:** no `eslint-disable`, `@ts-ignore`, `@ts-expect-error`, `@ts-nocheck` or `svelte-ignore`. ESLint runs with inline config off. Loosening a lint or compiler setting is a reviewed change, never a fix.
- **Conditions say what they test:** `x !== undefined`, `list.length > 0`, never bare truthiness (`strict-boolean-expressions`).
- **Discriminated unions, no optional props.** Model "maybe" as `{ kind: 'none' } | { kind: 'user'; … }`. Every `switch` on a union handles every case. Component props are mandatory; pass `undefined` explicitly where a snippet is not used.
- **Shared components take no `class` or `style` props**; they own their look.
- **Svelte 5 runes:** `$derived` for computed values, never `$state` kept in sync by hand. `$effect` only for the DOM and outside systems; prefer `onMount` for one-off browser reads. Every `{#each}` is keyed. No `{@html}`.
- **Compiler-driven refactoring:** make the new thing mandatory, run `npm run check`, and treat the errors as the to-do list.
- **File size:** plan a split at 600 lines; 1000 lines fails hygiene. Never squash lines to fit.
- **Exact dependency versions** (`save-exact`). No `^` or `~`, no URL imports.
- **Logging** goes through the server logger; `console.*` is a lint error outside `scripts/`.
- Comments explain why, not what. No commented-out code.

---

## 8. Verify, version and commit

- `npm run verify` runs lint, type check, format check, hygiene, dead code and duplication in parallel, then the tests and the build, and prints one pass/fail table. The pre-push hook runs `verify --fast --skip-if-verified`.
- Run checks as separate commands; never chain them so one failure hides another.
- **Version:** bump `package.json` (semver) for every user-visible change and add a line to `src/lib/domain/releases/changelog.ts` in plain words.
- **Commits:** imperative subject, body with the why. Never add AI co-author trailers or "generated with" footers. Jack Brumley is the only author of record.
- **Never push without the developer's go-ahead.** Never discard someone else's changes with `checkout`, `restore`, `reset`, `stash` or `clean`.

---

## 9. Fail hard

- No silent fallbacks. Missing configuration throws at start-up (`src/lib/server/env.ts`).
- A lookup that must succeed throws or returns a typed error; it never returns a made-up default.
- Errors shown to admins carry the real reason. Errors shown to members are plain, and the detail goes to the log.

---

## 10. Simplicity, zero shims, zero tech debt

- Solve by deleting first. The smallest change that is fully right wins.
- **One path per capability.** No second way to do the same thing "for now".
- **Zero shims:** no re-export facades, compatibility wrappers or translation layers. When a name or shape changes, change every caller in the same commit.
- JSON and URL parameters are camelCase; the database is snake_case.
- Dead code is removed in the same change that makes it dead (`npm run deadcode`).

---

## 11. Security, sign-in and access

The design is in `docs/access-and-sign-in.md`.

- **Sign-in** proves identity: Argon2id passwords, or OpenID Connect providers (authorisation code with PKCE, `state` and `nonce`, ID tokens checked against JWKS). Admins can always sign in with a password (break-glass).
- **Access** is BMuster's own: user groups, machine groups and additive access rules. Every permission check goes through the access service; routes never test roles or groups themselves.
- **Check twice:** the server checks permissions when listing machines and when starting a session; the session ticket the agent receives names the permissions it carries, and the agent enforces them.
- **Secrets** (provider client secrets, signing keys) are encrypted at rest, write-only in the UI, and never logged or sent to the browser.
- **Audit** every sign-in, session start and end, file transfer, share link and change to users, groups, rules or settings.
- Console session cookies are HttpOnly, Secure, SameSite=Lax. State-changing requests are checked for origin.
- Never weaken a check, widen a CORS rule or skip a signature check to make something work.

---

## 12. UI components and forms

- **Feedback:** toasts for results, `confirmAction` for anything destructive. Never `alert()` or `confirm()`.
- **Records:** a data table, then a view modal, then an edit modal (Save and Cancel in the footer).
- **Forms** validate with the same zod schema the server uses; field errors sit under their field.
- **Buttons** always have `type`. Icon-only buttons have `aria-label`.
- Every page works with the keyboard and has visible focus.

---

## 13. Sessions and the relay

- All traffic is HTTPS and WebSockets on one port. No inbound ports on agents.
- The server relays session bytes and never decodes desktop video.
- Each session has its own stream so a busy desktop never blocks control messages.
- Sessions survive a browser reload: the browser re-subscribes to the running session.

---

## 14. The agent (Rust)

- Lives in `agent/` as a Cargo workspace. Written fresh; it shares ideas with Wannon Beacon (launcher and worker, signed self-update with rollback, Ed25519 identity) but no code.
- **One generic installer** for every machine: the join code and server URL are arguments, never baked into the binary.
- **Identity:** an Ed25519 key pair made on first run; the private key never leaves the machine. Short-lived tokens from signed assertions.
- **Updates** are signed with a key kept off the server; the agent refuses anything else. The launcher never replaces itself during an update.
- **Least surprise on the machine:** no telemetry, nothing sent except to its own server, consent prompts honoured.
- Gate: `cargo fmt --check`, `cargo clippy -- -D warnings`, `cargo test`, run by `npm run verify`.

---

## 15. Tests

- Vitest projects: `unit` (Node) and `ui` (browser, Playwright).
- `requireAssertions`, `restoreMocks`, `unstubEnvs` and `unstubGlobals` are on.
- Database tests use a fresh in-memory SQLite database per file, migrated from the real migrations. Each test seeds its own rows.
- Tests live beside the code (`*.test.ts`, `*.svelte.test.ts`) or under `tests/`.

---

## 16. Hygiene

`npm run hygiene` runs project-specific checks that lint cannot express. Each rule is registered in `scripts/hygiene/rules.ts` with its section, why and fix, and has a bad and a good fixture under `tests/unit/hygiene/`. The index below is generated by `npm run hygiene:docs`; do not edit it by hand.

<!-- BEGIN GENERATED: hygiene rule index -->

- `any-type-forbidden` (violation, §7): `any` switches type checking off for
  everything it touches. **Fix:** Use `unknown` and narrow it, or write the
  specific type.
- `artefact` (violation, §2): Backup and temporary files (`backup`, `temp`,
  `tmp` or `old` in the name) in src/ get shipped and confuse readers. **Fix:**
  Delete the file; git history is the backup.
- `australian-spelling-violation` (violation, §7): BMuster is written in
  Australian English, in the UI and in code. **Fix:** Spell it `organisation`
  (with an s).
- `border-radius-token-required` (violation, §4): Corner radius is picked by
  role so buttons, fields, cards and modals match on every screen. **Fix:** Use
  `var(--radius-<role>)` (pill, control, card, modal, inner, round) or 0.
- `browser-imports-server-forbidden` (violation, §6): Code the browser loads
  that imports from src/lib/server/** (even a type) drifts from what the server
  sends and is one import away from bundling server code. **Fix:** Declare the
  shape in src/lib/domain/<area>/ and import it from there on both sides; name a
  server-only route helper *.server.ts.
- `browser-native-dialog-forbidden` (violation, §12): `alert`, `confirm` and
  `prompt` block the page and look different on every device. **Fix:** Show a
  toast for results and use `confirmAction()` for anything destructive.
- `claude-symlink` (violation, §16): CLAUDE.md links to AGENTS.md so every agent
  reads the same rules. **Fix:** Run `ln -sf AGENTS.md CLAUDE.md`.
- `client-raw-fetch-forbidden` (violation, §6): Browser code talks to the server
  through one client that handles headers, errors, expiry and the reply
  contract. **Fix:** Use the API client in src/lib/utils/api-client.ts with a
  zod reply contract.
- `css-placement` (violation, §4): Global CSS lives in two files; stray
  stylesheets leak styles across components. **Fix:** Move the styles into the
  component’s scoped `<style>` block (global rules go in src/app.css).
- `destructive-request-confirmation` (violation, §12): A delete, remove or
  revoke sent without a confirmation dialog is one stray tap from losing data or
  access. **Fix:** Confirm with `confirmAction()`, or list a caller-confirmed
  helper in DESTRUCTIVE_REQUEST_EXEMPTIONS.
- `double-cast-forbidden` (violation, §7): A cast through `unknown` converts
  anything into anything and switches type checking off. **Fix:** Type the value
  properly: a generic, a type guard, narrowing or a zod parse at a trust
  boundary.
- `each-block-key-required` (violation, §7): An unkeyed `{#each}` reuses rows by
  position, so row state jumps when the list changes. **Fix:** Key the block:
  `{#each items as item (item.id)}`.
- `env-direct-access-forbidden` (violation, §9): Reading process.env outside
  env.ts skips the fail-hard start-up check. **Fix:** Add the value to `env` in
  src/lib/server/env.ts and read it from there.
- `env-var-registered` (violation, §9): .env.example is the list of settings an
  installer fills in, so it must match what env.ts reads. **Fix:** Add the
  variable (with a comment) to .env.example, or remove the entry nothing reads.
- `file-size` (violation, §7): Files over 1000 lines are too big to read and
  review as one unit. **Fix:** Split the file along functional boundaries
  (sub-components, helpers, services); never squash lines.
- `file-size-soft` (warning, §7): Files over 600 lines are the signal to plan a
  split before they reach the hard limit. **Fix:** Plan and make a split into
  sub-components, helpers or services.
- `fixed-edge-safe-area` (violation, §4): A fixed element pinned to the top or
  bottom of the screen sits under the status bar, notch or home bar on phones.
  **Fix:** Offset it by the inset: `top: calc(<gap> + var(--safe-top))`,
  `bottom: calc(<gap> + var(--safe-bottom))`.
- `git-naming-case` (violation, §2): A case-only rename git did not record
  passes on a case-insensitive disk but breaks Linux builds. **Fix:** Rename the
  tracked path to kebab-case with `git mv`.
- `git-naming-case-failed` (violation, §2): Tracked file names cannot be checked
  when `git ls-files` fails. **Fix:** Run hygiene inside the git working tree
  and make sure git works.
- `hardcoded-color-forbidden` (violation, §4): Literal colours ignore the theme
  (dark mode) and drift from the palette. **Fix:** Use a design-token variable,
  `var(--…)`; add a `light-dark()` token to src/lib/ui/design-tokens.css if none
  fits.
- `hygiene-docs-current` (violation, §16): The hygiene rule index in AGENTS.md
  is generated from the rule registry and must match it. **Fix:** Run
  `npm run hygiene:docs`.
- `important-forbidden` (violation, §4): `!important` overrides the cascade and
  hides specificity problems. **Fix:** Fix the selector or the structure
  instead.
- `inline-dependencies-forbidden` (violation, §7): `npm:`, `jsr:` and URL
  imports bypass package.json, so versions and audits drift. **Fix:** Add the
  package to package.json with an exact version and import it by name.
- `input-font-size-ios-zoom` (violation, §4): iOS zooms the page when a text box
  under 16px is focused (inputs, textareas, selects, contenteditable, xterm.js),
  cropping the phone layout. **Fix:** Size text boxes with `var(--text-base)` or
  a larger token (never `inherit`, `em` or `calc()`), and keep the 16px base
  rule for text boxes in src/app.css.
- `lib-root-file-forbidden` (violation, §2): src/lib/ holds only the area
  folders, so loose modules or new top-level folders leave nobody sure where a
  file belongs. **Fix:** Move the file into its folder (server/, domain/,
  schemas/, ui/, shell/, runes/ or utils/) and update its imports.
- `lint-bypass-forbidden` (violation, §7): Bypass pragmas (eslint, TypeScript,
  Svelte) hide real problems from the checks. **Fix:** Delete the pragma and fix
  the code so it passes natively.
- `naming` (violation, §2): File and folder names are kebab-case so imports work
  on case-sensitive Linux builds. **Fix:** Rename the file or folder to
  kebab-case (SvelteKit route files and `[param]` folders are exempt).
- `page-frame-required` (violation, §4): A page outside ShellFrame and
  PublicPage lays out its own edges, so on phones it can sit under the status
  bar, notch or home bar. **Fix:** Put the page under the (console) layout
  (ShellFrame), or render it in `<PublicPage>` (#lib/shell/public-page.svelte).
- `page-header-required` (violation, §4): A console page without PageHeader puts
  its title somewhere else, so pages jump about when moving between them.
  **Fix:** Start the page with `<PageHeader>` (#lib/ui/page-header.svelte), or
  list its folder in PAGE_HEADER_FROM_LAYOUT with the reason.
- `page-root-container-forbidden` (violation, §4): A full-screen-height
  container outside the two frames is a page building a frame of its own,
  without the safe-area insets. **Fix:** Drop the container; only ShellFrame and
  PublicPage size themselves to the screen.
- `raw-button-reason-required` (violation, §12): Raw `<button>`s skip the
  standard Button’s look, size and focus behaviour. **Fix:** Use `<Button>`
  (src/lib/ui/button.svelte), or for a specialised widget add
  `data-raw-button="<reason>"` from the list in raw-controls.ts.
- `raw-emoji-forbidden` (violation, §5): Raw emoji render differently on every
  operating system and look unprofessional. **Fix:** Use a Tabler icon from
  @tabler/icons-svelte-runes.
- `raw-html-forbidden` (violation, §7): `{@html}` renders unescaped HTML: a
  cross-site scripting risk in a tool that controls other computers. **Fix:**
  Render the content with components.
- `raw-input-reason-required` (violation, §12): Raw fields skip the standard
  field’s label, error slot and phone sizing. **Fix:** Use `<TextField>`
  (src/lib/ui/text-field.svelte), or for a specialised widget add
  `data-raw-input="<reason>"` from the list in raw-controls.ts.
- `redirect-cookie-mutation-forbidden` (violation, §6): A `Response.redirect`
  has immutable headers, so setting a cookie on it throws at runtime. **Fix:**
  Set cookies with `event.cookies` and redirect with `redirect()` from
  @sveltejs/kit.
- `redirect-header-mutation-forbidden` (violation, §6): A `Response.redirect`
  has immutable headers, so changing them throws at runtime. **Fix:** Use
  `redirect()` from @sveltejs/kit, or build a `Response` with a Location header.
- `relative-dynamic-import-forbidden` (violation, §7): Relative dynamic imports
  make the server build evaluate the module graph at runtime. **Fix:** Use a
  static top-level import (`#lib/…`).
- `route-card-look-forbidden` (violation, §4): A page that draws its own card
  (card radius with a border or shadow, or the card shadow) drifts from every
  other card in the console. **Fix:** Use `<Panel>` or `<ListCard>` from
  src/lib/ui; change the shared component if every card needs the change.
- `route-guard-required` (violation, §11): A route handler not built by a guard
  runs without checking who is asking. **Fix:** Export it as
  `route.<public|user|admin|agent>(…)` or `page.<public|user|admin>(…)` from
  src/lib/server/guards/; `route.diagnostics(…)` only for GET under
  src/routes/api/diagnostics/.
- `server-imports-app-modules-forbidden` (violation, §6): src/lib/server/** runs
  outside Vite (scripts, tests), where `$app/*` and `$env/*` do not exist.
  **Fix:** Take what the module needs as a parameter from the route or hook.
- `snake-case-url-query-parameter-forbidden` (violation, §10): BMuster’s own
  query parameters are camelCase; mixed casing leads to dual-case fallbacks.
  **Fix:** Rename the parameter to camelCase everywhere (names fixed by an
  outside protocol go in externalProtocolQueryParams).
- `style-module-file` (violation, §4): `*-styles.ts` modules hold style strings
  the token checks cannot see. **Fix:** Move the styles into the component’s
  scoped `<style>` block.
- `style-token-required` (violation, §4): Spacing, type and shadow values come
  from the token scale so screens stay consistent. **Fix:** Use `var(--…)` (or
  0, %, fr, auto or a keyword).
- `svelte-parse-error` (violation, §16): A component svelte/compiler cannot
  parse is skipped by every other rule. **Fix:** Fix the syntax error the
  message names (svelte-check shows it too).

<!-- END GENERATED: hygiene rule index -->

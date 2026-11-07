# SPEC-ERROR-PAGES: Themed error pages

**Status:** IMPLEMENTED (v0.2.0) · 2026-11-08.

## Problem

Missing pages and failed requests need useful recovery actions in BMuster's existing theme, without disclosing internal errors or machine access.

## Acceptance criteria

| Criterion                                                                                                 | Test                                                 |
| :-------------------------------------------------------------------------------------------------------- | :--------------------------------------------------- |
| E1: Public errors show status-specific wording, sign-in or Machines, Back and retry for server errors.    | `public-error.svelte.test.ts`, `error-copy.test.ts`  |
| E2: Console errors preserve the frame and hide whether a missing machine exists.                          | `console-error.svelte.test.ts`, `error-copy.test.ts` |
| E3: Machine tab errors preserve the header and tabs.                                                      | `console-error.svelte.test.ts`, HTTP smoke test      |
| E4: Unknown API endpoints return a guarded JSON 404.                                                      | `api-not-found.test.ts`, HTTP smoke test             |
| E5: Unexpected errors log their reason with a reference; responses contain a plain message and reference. | `handle-error.test.ts`                               |
| E6: A standalone fallback renders when Svelte cannot render.                                              | Static fallback inspection, HTTP smoke test          |

## Design and security

No database or permission changes. Existing guards still decide access. Unexpected exceptions are never sent to the browser. Expected route errors retain their status and message. The fallback is self-contained because external styles and Svelte may be unavailable.

## Open questions

None within the approved scope.

## As built

Public and console errors share error copy, actions and illustrations. Machine tab errors preserve their parent layout. The API fallback is authenticated. All checks use isolated storage. HTTP smoke tests covered unknown API paths (401/404), phone-support enrolment, and 404 pages at 390px and 1280px in light and dark themes. Screenshots showed no horizontal overflow.

The changelog lives under `src/lib/domain/releases/` to follow the repository's folder-only `src/lib/` rule; AGENTS.md now points to that canonical path.

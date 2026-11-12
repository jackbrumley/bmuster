# SPEC-RELEASE-NOTES: What to test on real machines, in every release's notes

**Status:** `IMPLEMENTED (v0.4.22)` 2026-11-12 · asked for by Jack (housekeeping: "Release notes: what to test")

## Problem

GitHub releases carried only GitHub's generated list of commits, and the changelog said what changed but not what to try by hand. Much of BMuster can only be checked on real machines (a phone in the hand, a KDE lock screen, Fedora with SELinux enforcing), and those checks were remembered, not written down.

## Design

- Each entry in `src/lib/domain/releases/changelog.ts` carries `testing`: `{ kind: 'none' }` or `{ kind: 'steps'; steps: [string, ...string[]] }` (a discriminated union, AGENTS.md section 7). Past releases are `none`.
- `scripts/release/notes.ts` writes a release's body from its entry: "What changed" (the changes), then "What to test on real machines" (the steps, or "Nothing listed for this release."). `node scripts/release-notes.ts <tag>` (`npm run release:notes`) prints it.
- The release workflow's `check` job runs the script for a release tag, so a tag with no changelog entry fails before anything is built; the `publish` job passes the body with `--notes-file` (GitHub's generated list follows it).
- The Updates page's release notes (`src/routes/(console)/updates/release-notes.svelte`) show the steps under a release's changes, and leave the section out when there are none.

## Acceptance criteria

| #   | Criterion                                                                                                                                       | Test                                                        |
| :-- | :---------------------------------------------------------------------------------------------------------------------------------------------- | :---------------------------------------------------------- |
| R1  | Every changelog entry says what to test on real machines: none, or a non-empty list (type-checked with `satisfies`); each version appears once. | `tests/unit/release-notes.test.ts`, `npm run check`         |
| R2  | A release's GitHub notes list what changed, then "What to test on real machines" with its steps, or say nothing is listed.                      | `tests/unit/release-notes.test.ts`                          |
| R3  | A release tag whose version has no changelog entry is refused before anything is built.                                                         | `tests/unit/release-notes.test.ts`                          |
| R4  | The Updates page shows a release's steps under its changes, and no such section when it lists none.                                             | `src/routes/(console)/updates/release-notes.svelte.test.ts` |

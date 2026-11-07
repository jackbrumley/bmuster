# Development status

Updated 2026-11-08 after recovering the interrupted session.

## Completed in the recovery batch (0.2.0)

- Public `/join` phone support, started by an admin on Add machine: a single-use 15-minute support code, caller warning questions, install commands for available builds and a Connected state after enrolment.
- Phone-support organisation and warning wording in Settings; code creation, use and cancellation in Activity; guessing limits on public endpoints.
- Themed public, console and machine error pages, guarded JSON for unknown API endpoints, and log references for unexpected exceptions.
- Release notes on Updates, with server and Rust workspace versions aligned at 0.2.0.
- A signed local Linux development agent rebuilt through `npm run agent:release-local`. No production tag or release created.

Checks and smoke tests use isolated storage. The smoke test enrolled only a scratch identity; it did not operate the installed machine agent.

## Next: server updates

`docs/specs/SPEC-SERVER-UPDATES.md` is ready for review. No updater implementation survived the previous interruption. The design starts with the manual Check for updates button, daily checks, notice/modal and live agent update rows, then adds signed application updates and recovery in the launcher.

Review is needed for the concrete privilege, signature and schema-rollback constraints in that spec. The current installed server deliberately cannot overwrite its program directory; the web app must not acquire administrator privileges to implement updating.

Before publishing: confirm the GitHub signing secret without exposing it, make the release workflow refuse unsigned production releases, run the workflow dry run and its install/update tests, then choose the first release tag. Do not publish just because the local version is 0.2.0.

## Other outstanding work

- Real Windows helper, lock-screen and UAC testing; real Linux greeter and multi-monitor testing.
- Desktop H.264, consent prompts, clipboard and Wayland support.
- MCP spec review and implementation with explicit approval for every command.
- Production deployment on Coolify behind the reverse proxy, using the generic hosting guide.
- Temporary vendor links, privacy controls, provider group sync, macOS and agentless inventory/config-backup ideas.
- Last priority: move the repository to the reserved organisation; keep it under the personal account for now.

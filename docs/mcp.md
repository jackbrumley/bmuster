# MCP: letting a coding agent help administer machines

Status: idea, 2026-11-07. Not scheduled; the pieces it needs are built in the order below so nothing has to be redone.

## Goal

Connect a coding agent (Claude Code, opencode, …) to BMuster as an MCP server, and ask it things like "log into build-01 and tell me why the service is failing". The agent proposes commands; **a person approves each one in BMuster before it runs**; the output goes back to the agent.

## Shape

```
Coding agent ──MCP (Streamable HTTP, OAuth)──▶ BMuster server ──approval request──▶ person (console, phone)
                                                     │  approved
                                                     ▼
                                              agent on the machine runs the command, returns output
```

- BMuster serves MCP at `/mcp`. The coding agent signs in with OAuth as a BMuster user, so it can never do more than that person.
- Tools (first set):
  - `list_machines`: machines the user may see, with status.
  - `get_machine`: inventory and recent status for one machine.
  - `run_command`: machine, shell, command, timeout. Returns stdout, stderr, exit code, duration.
  - Later: `read_file`, `list_directory`, `get_service_status` as narrower, read-only tools.

## Guards

- **A separate permission, `ai-commands`,** given by access rules like any other. Holding `terminal` does not imply it.
- **A per-user switch:** an admin turns MCP on for a person; it is off by default.
- **Every action is approved by a person in BMuster**, not only in the coding agent's own prompt. The approval shows the machine, the exact command, the shell, who is asking (user and MCP client) and the reason the agent gave. Approve or deny; requests expire after 5 minutes.
- **Approvals happen on the server,** so a misbehaving or compromised MCP client cannot skip them.
- **Limits:** timeout per command (default 60 s, max 10 min), output capped (default 1 MB), one running command per machine per user.
- **Audit:** request, approver, decision, command, exit code, duration, and the full output kept with the session record.
- The person at the screen's consent rules still apply.
- Later: per-rule allow-lists for read-only commands that may skip approval, only if the developer chooses to add them.

## What it needs underneath (and when it is built)

1. Sign-in and console users (SPEC-SIGN-IN): MCP tokens belong to a user.
2. An **exec** action in the agent: run one command non-interactively with a timeout and an output cap, started only by a server-signed ticket naming that permission. Built with terminal sessions (SPEC-SESSIONS), because it shares the ticket and relay.
3. Approval requests in the console, with push or toast notification.
4. The MCP endpoint and OAuth for MCP clients.

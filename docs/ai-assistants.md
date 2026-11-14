---
layout: default
title: Connect an AI assistant | BMuster
description: How to connect Claude, Codex, ChatGPT, VS Code, Cursor or any other MCP assistant to your BMuster server, and how BMuster keeps a person in charge of every command.
canonical: https://bmuster.com/ai-assistants
---

# Connect an AI assistant

BMuster can let an AI assistant (Claude, Codex, ChatGPT or any other assistant that supports MCP, the Model Context Protocol) look at your machines and ask to run commands on them, as the person who connected it. The assistant never runs anything on its own: every command waits for a person to approve it in BMuster.

## How approval works

- **The assistant acts as you.** It signs in through BMuster, and you press Allow. It sees only what an access rule opens to AI for you, admins included.
- **Two permissions.** _AI can view_ lets it see a machine's inventory, status and recent activity, and nothing more. _AI commands_ also lets it ask to run commands there.
- **A person approves every command.** A request waits on the Approvals page, and every BMuster tab you have open shows a notice. You see the machines, the shell and the exact command, with any hidden characters marked. You approve it, edit it and approve, or deny it with a note. Approving needs the Run commands permission and a recent sign-in. A request nobody decides expires after 10 minutes.
- **Output is data.** What a machine prints goes back to the assistant as data from the machine, never as instructions.
- **Everything is recorded.** Activity shows each step as "your name via the assistant". You can disconnect an assistant from your Account page at any time, and an admin can stop all AI access at once.

## Once per server: an admin turns it on

1. In BMuster, open **Settings → AI assistants**. Turn _Allow AI assistants (MCP)_ on, choose the group of people who may connect one, and press Save.
2. On **Access rules**, add a rule for those people and the machines the assistant may use. Give **AI can view** for read-only access, or **AI commands** to let it ask to run commands. AI commands includes AI can view. Admins get neither unless a rule gives it.
3. Optionally, under **Settings → AI assistants**, choose who may approve: the person who asked (the default), or a group of approvers.

## Connect your assistant

Your server's MCP address is `https://<your BMuster server>/mcp`. Each person connects their own assistant. The console shows these same steps, with your server's address filled in, in the _Connect an AI assistant_ panel on your Account page.

Menu names in these apps change often. If one is not there, look for the nearest match.

claude.ai and ChatGPT connect from their own cloud, so your BMuster server must be reachable from the internet for them. Terminal and editor tools (Claude Code, Codex, VS Code, Cursor) connect from your own computer, so they also work on a private network your computer can reach.

### Claude Code

1. In a terminal, add BMuster:

   ```sh
   claude mcp add --transport http bmuster https://<your BMuster server>/mcp
   ```

2. In Claude Code, type `/mcp`, choose **bmuster**, then **Authenticate**.
3. Your browser opens BMuster: sign in if asked, and press **Allow**.

### Codex

The Codex terminal and desktop app share these settings.

1. In a terminal, add BMuster, then sign in:

   ```sh
   codex mcp add bmuster --url https://<your BMuster server>/mcp
   codex mcp login bmuster
   ```

2. Your browser opens BMuster: sign in if asked, and press **Allow**. **Keep the terminal open until it prints success.** A browser error page at `127.0.0.1:<port>/callback` means the command was closed too early; run it again.
3. Restart the Codex app.

Add BMuster as a plain MCP server like this. A Codex plugin wrapping the address did not load it in testing.

### claude.ai and the Claude desktop app

Paid plans.

1. Open **Settings → Connectors → Add custom connector**.
2. Name it **BMuster** and paste your server's MCP address.
3. Press **Connect**, sign in to BMuster and press **Allow**.

The connector belongs to your Claude account, so it follows you to your other devices. On Team and Enterprise plans an owner adds it first.

### ChatGPT

Paid plans.

1. Open **Settings → Apps & Connectors → Advanced settings** and turn **Developer mode** on.
2. Press **Create**. Name it **BMuster**, paste your server's MCP address, and choose **OAuth** for authentication.
3. Press **Connect**, sign in to BMuster and press **Allow**.

The connector belongs to your ChatGPT account.

### VS Code

1. Open the Command Palette and run **MCP: Add Server**.
2. Choose **HTTP** and paste your server's MCP address.
3. When VS Code asks, sign in to BMuster and press **Allow**.

### Cursor

1. Add BMuster to `~/.cursor/mcp.json` (inside any `mcpServers` already there):

   ```json
   { "mcpServers": { "bmuster": { "url": "https://<your BMuster server>/mcp" } } }
   ```

2. When Cursor asks you to log in to bmuster, sign in to BMuster and press **Allow**.

### Other assistants

1. Look for "add MCP server", "custom connector" or "remote MCP".
2. Choose **HTTP** (or Streamable HTTP) and paste your server's MCP address.
3. Choose **OAuth** if asked. Leave the client ID and secret blank.
4. Sign in to BMuster and press **Allow**.

## Check it worked

Ask your assistant to "list my BMuster machines". It answers with the machines an access rule opens to AI for you, and the request shows in BMuster's Activity as "your name via the assistant". To disconnect, press **Disconnect** next to it on your Account page.

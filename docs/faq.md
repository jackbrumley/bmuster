---
layout: default
title: Questions and answers | BMuster
description: How to get back into a locked BMuster server, connect an AI assistant, approve its commands, set up saved commands, and copy text and files through a remote session.
canonical: https://bmuster.com/faq
---

# Questions and answers

Short answers to what people ask most, from first steps to getting back into a locked server. For connecting a particular AI assistant step by step, see [Connect an AI assistant](/ai-assistants).

- [Getting back in](#getting-back-in)
- [AI assistants](#ai-assistants)
- [Saved commands](#saved-commands)
- [Running commands on many machines](#running-commands-on-many-machines)
- [Copy, paste and files in a remote session](#copy-paste-and-files-in-a-remote-session)
- [Security and backups](#security-and-backups)

## Getting back in

### I forgot my password, or lost my authenticator app. How do I get back in?

If you lost your authenticator and another admin can sign in, they can **Reset two-factor** on your account from **Users**. An admin's password can only be changed by that admin, or with the command below; a member's password can be reset from **Users**.

If you are the only admin, run one of these on the computer that hosts the BMuster server. Each prints what it did and is recorded in Activity as done by System.

**Linux** (installed with the one-line installer):

```sh
sudo /opt/bmuster-server/current/bmuster-server reset-password --email you@example.com
sudo /opt/bmuster-server/current/bmuster-server reset-two-factor --email you@example.com
```

**Windows** (PowerShell, run as Administrator):

```powershell
& "C:\Program Files\BMuster Server\current\bmuster-server.exe" reset-password --email you@example.com
& "C:\Program Files\BMuster Server\current\bmuster-server.exe" reset-two-factor --email you@example.com
```

**Docker or Coolify** (as the container's own user, without `-u root`):

```sh
docker exec <container> bmuster-server reset-password --email you@example.com
docker exec <container> bmuster-server reset-two-factor --email you@example.com
```

`reset-password` prints a new password once and ends that admin's sessions; sign in with it, then choose your own. `reset-two-factor` turns two-factor sign-in off for that account; if your server requires it, you set it up again at your next sign-in. If you installed with a custom data folder, add `--data-dir <folder>`. These commands arrived in BMuster 0.4.35; on older versions, update first or see the hosting guide in the repository.

### Should I turn on two-factor sign-in?

Yes, if you sign in with a password. Turn it on for yourself on your **Account** page (scan the QR code with an authenticator app and keep the recovery codes), then require it for admins under **Settings → General → Security** (**Two-factor sign-in**). People who sign in through Microsoft 365 or Authentik use that provider's two-factor instead.

## AI assistants

### Which AI assistants can connect?

Any assistant that supports MCP (the Model Context Protocol): Claude (Claude Code, claude.ai and the Claude desktop app), Codex, ChatGPT, VS Code with Copilot, Cursor and others. The step-by-step guide for each is on [Connect an AI assistant](/ai-assistants), and the same steps, with your server's address filled in, are in BMuster under **Account → How to connect**.

### What do I set up in BMuster first?

Once per server, as an admin:

1. **Settings → AI assistants**: choose **People who may connect an AI assistant** (a user group you are in), switch on **Allow AI assistants (MCP)**, and save.
2. Decide what the assistant may reach. Admins included, an assistant sees nothing until you allow it:
   - **AI can view**: it can list machines and read their details (system, disks, memory, uptime, who is signed in). It cannot ask to run anything.
   - **AI commands (with approval)**: it can also ask to run commands; each one waits for a person.

   The quickest way is the buttons on **Settings → AI assistants**: **Let AI view all machines** and **Let AI ask to run commands on all machines**. For finer control, add access rules in **Access → Rules** for chosen machine groups.

Then connect your assistant to `https://<your BMuster server>/mcp` and sign in when it asks. Ask it "list my BMuster machines" to check.

### My assistant says it can see 0 machines.

It is connected, but no rule opens any machine to AI yet. Use the buttons on **Settings → AI assistants**, or add a rule with **AI can view** or **AI commands** for your group.

### My assistant doesn't show a new tool after I updated BMuster.

Assistants read the list of tools when a conversation or the app starts. Start a new chat, or restart the app, after updating BMuster.

### How does approving a command work?

1. The assistant asks to run a command, with its reason.
2. BMuster holds it: nothing runs. A notice appears in your open BMuster tabs, and the request is on **Approvals**.
3. You read the exact command, the machines and the reason, then **Approve**, **Edit** and approve, or **Deny** with a note the assistant reads. Approving asks for your password, or your authenticator code, if you signed in more than 10 minutes ago.
4. The command runs, and the assistant gets the output. If you approve within about 45 seconds it gets the answer straight away; otherwise it keeps checking until the command finishes. Requests nobody decides expire after 10 minutes.

Everything is recorded in Activity as "you via the assistant". The assistant can never approve its own request: approving only happens in BMuster, signed in as you.

### Can the AI see where disk space went?

Yes, on machines where it has **AI can view** and you have **Files**, the same permission the **Storage** tab needs. Ask "what is filling the disk on mint?" and it reads the scan BMuster's agent already keeps of each drive: the biggest folders and files, how old the scan is, and how much each safe clean-up item would free. It needs no approval and starts no new disk walk; it can ask for a fresh scan at most once every 10 minutes per machine.

It can also ask to clean up items from BMuster's fixed safe list (temporary files, update downloads, package caches, crash dumps, Recycle Bins and the like). That needs **AI commands** and **Files**, and always waits for you on **Approvals**, showing each item, its size and the total. Deleting anything else is an ordinary command you approve like any other.

### Can I disconnect an assistant?

Yes. Disconnect one on your **Account** page, or stop every assistant at once with **Stop all AI access** on **Settings → AI assistants**.

## Saved commands

### What are saved commands?

Scripts an admin writes once, under **Commands → Saved commands**: a name, a description, a script per system (Windows, Linux), the machine groups it may run on, and optional parameters (numbers, choices or checked text, passed to the script safely as environment variables). People run them in two clicks; AI assistants can run them too.

### How do I let the AI run a saved command without asking me?

1. Open **Commands → Saved commands** and the command you want.
2. Tick **Switched on**, so it can run at all.
3. Tick **AI may run this without approval**.
4. Make sure **Allow AI to run saved commands without approval** is on in **Settings → AI assistants** (it is by default).
5. The assistant needs **AI commands** on the machine, and the command must be allowed on that machine's group.

Saved commands without that tick still work for the AI, but wait on **Approvals** like any other command. The assistant sees each command's description and whether it "Runs at once" or "Needs a person's approval", never the script itself. Runs without approval are capped at 60 an hour per connected assistant, and appear in Commands and Activity marked as pre-approved.

### Which saved commands come with BMuster?

Eight read-only starters, all switched off until you turn them on: check for updates (lists, installs nothing), disk space, uptime and last boot, top processes, service status, recent system errors, network settings, and installed software. Each has a Windows and a Linux script.

### What do "Reads only" and "Changes the machine" mean?

A label the admin chooses, shown on every run. Use "Changes the machine" for anything that installs, removes, restarts or edits; turning on unattended AI runs for those asks you to confirm.

## Running commands on many machines

### How do I run one command on several machines?

On **Machines**, press **Select**, tick machines or tap a group chip (and Windows, Linux, Online), then **Run command**. Type a command (one box per system when the selection mixes Windows and Linux) or pick a saved command, review every machine, and confirm. You see each machine's output live while it runs, and past runs stay under **Commands**. Running commands needs the **Run commands** permission.

## Copy, paste and files in a remote session

### How do I paste something from my computer into the remote machine?

Click the remote screen and press **Ctrl+V** (Cmd+V when controlling a Mac). BMuster sends your text to the machine's clipboard first, then pastes it. This works in every browser, including Firefox and Safari, in the pop-out window too. After that, right-click → Paste on the machine works as well. Copying on the machine lands on your computer by itself.

### Can I copy files to and from the machine?

From BMuster 0.4.35: drop files onto the remote screen, or use **Upload files**, and they are saved to the signed-in person's **Downloads → BMuster** folder and put on the machine's clipboard, so Ctrl+V pastes them into any folder. Files you copy on the machine show as **Download N files** in your browser. The **Files** tab browses the whole machine at any time.

## Security and backups

### What should I back up?

Two things, kept somewhere other than the server's own disk:

- **`server.env`**, in the data folder (`/var/lib/bmuster-server` on Linux, `C:\ProgramData\BMuster Server` on Windows). It holds the key that encrypts BMuster's secrets. Without it, a restored database can't decrypt two-factor, single sign-on, email or the server's own key, and every machine would need enrolling again.
- **The daily database snapshots** in the `backups` folder beside it (kept 14 days).

### What does BMuster encrypt?

Passwords are hashed (Argon2id). Secrets are encrypted with the key in `server.env`: single sign-on client secrets, the email password, two-factor secrets and the server's signing key. Recovery codes and AI assistants' tokens are stored only as hashes. For everything else in the database, use disk encryption (LUKS on Linux, BitLocker on Windows).

### Windows Defender blocked the agent on a new machine.

The Windows agent is new, unsigned software that controls the screen, so some machines' Defender settings block it. The install line then stops with a message pointing to **Windows Security → Protection history**. Code signing is being arranged (see the [code signing policy](/code-signing-policy)); until then, you can report the file to Microsoft as a false positive, or allow it in Protection history.

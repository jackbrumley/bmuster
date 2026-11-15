<script lang="ts">
	import { RECOVERY_FAQ_URL, type RecoveryFacts } from '#lib/domain/settings/recovery.ts';
	import CopyField from '#lib/ui/copy-field.svelte';
	import Panel from '#lib/ui/panel.svelte';

	/**
	 * Recovery (SPEC-SERVER-INSTALL I17): what to copy off this server, the two host commands
	 * for a lost password or authenticator, and the disk encryption tip. The paths and commands
	 * are this server's own. Admins only: the Settings page is.
	 */
	let { facts }: { facts: RecoveryFacts } = $props();

	function daysText(days: number): string {
		return days === 1 ? '1 day' : `${String(days)} days`;
	}

	const whereToRun = $derived.by(() => {
		switch (facts.deployment) {
			case 'linux':
				return 'In a terminal on the server:';
			case 'windows':
				return 'In PowerShell, run as Administrator, on the server:';
			case 'docker':
				return 'On the Docker host, with the container’s name for <container> (docker ps lists it):';
			case 'source':
				return 'In the checkout the server runs from:';
		}
	});
</script>

<Panel heading="Recovery" actions={undefined} tone="normal" padding="normal">
	<p class="text">
		What you need if this server’s disk fails or nobody can sign in. Set it up now, before you need
		it.
	</p>

	<div class="part">
		<h3>Back up the secrets key</h3>
		{#if facts.secrets.kind === 'settings-file'}
			<p class="text">Copy the settings file somewhere safe, away from this server:</p>
			<CopyField value={facts.secrets.path} label="the settings file’s path" />
			<p class="text">It holds SECRETS_KEY.</p>
		{:else if facts.secrets.kind === 'container-variable'}
			<p class="text">
				Keep the container's SECRETS_KEY variable in your password manager, as you set it in your
				host (Coolify, Compose).
			</p>
		{:else}
			<p class="text">Keep SECRETS_KEY, from .env or the server’s environment, somewhere safe.</p>
		{/if}
		<p class="hint">
			Without it a restored database is no use: sign-in providers and email lose their secrets, and
			every machine must be enrolled again.
		</p>
	</div>

	<div class="part">
		<h3>Copy the snapshots elsewhere</h3>
		{#if facts.snapshots.kind === 'daily'}
			<p class="text">
				{`A whole copy of the database is written here every night and kept for ${daysText(facts.snapshots.keep)}:`}
			</p>
			<CopyField value={facts.snapshots.folder} label="the snapshot folder" />
			<p class="hint">
				They sit on the same disk as the server, so a failed disk takes them too. Copy the folder to
				another machine or storage regularly.
			</p>
		{:else}
			<p class="text">
				Nightly snapshots are off (BMUSTER_BACKUP_KEEP=0), so nothing is written to {facts.snapshots
					.folder}. Back up the database another way, or turn them back on.
			</p>
		{/if}
	</div>

	<div class="part">
		<h3>Locked out</h3>
		<p class="text">
			Lost your password or authenticator, and no other admin can help? {whereToRun}
		</p>
		<CopyField value={facts.commands.resetPassword} label="the reset password command" />
		<p class="hint">Prints a new password once and signs you out everywhere.</p>
		<CopyField value={facts.commands.resetTwoFactor} label="the reset two-factor command" />
		<p class="hint">Turns two-factor sign-in off for that account.</p>
	</div>

	<p class="text">
		Turn on disk encryption (BitLocker on Windows, LUKS on Linux) on this server and wherever the
		copies go: the secrets key and a snapshot together open everything BMuster keeps.
	</p>
	<p class="text">
		The same steps in plain words are in the
		<a href={RECOVERY_FAQ_URL} target="_blank" rel="external noopener noreferrer"
			>questions and answers</a
		> on bmuster.com.
	</p>
</Panel>

<style>
	.part {
		display: grid;
		gap: var(--space-2);
	}

	h3 {
		font-size: var(--text-base);
		font-weight: var(--weight-semibold);
	}

	.text {
		color: var(--text-soft);
		font-size: var(--text-sm);
	}

	.hint {
		color: var(--muted);
		font-size: var(--text-xs);
	}

	a {
		color: var(--brand);
	}
</style>

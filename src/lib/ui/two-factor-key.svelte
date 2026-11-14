<script lang="ts">
	import type { TwoFactorKey } from '#lib/domain/auth/two-factor.ts';
	import CopyField from './copy-field.svelte';

	/**
	 * Set-up's key (SPEC-TWO-FACTOR 2.6): the QR code the server drew, and the same key as text
	 * for an authenticator app on the computer itself. Used on the Account page and at sign-in.
	 */
	let { twoFactorKey }: { twoFactorKey: TwoFactorKey } = $props();
</script>

<div class="key">
	<ol class="steps">
		<li>
			Open an authenticator app on your phone (for example Google Authenticator, Microsoft
			Authenticator, 1Password or Bitwarden).
		</li>
		<li>Add an account and scan this code.</li>
	</ol>
	<svg
		class="qr"
		viewBox="0 0 {twoFactorKey.qr.size} {twoFactorKey.qr.size}"
		role="img"
		aria-label="QR code for your authenticator app"
		shape-rendering="crispEdges"
	>
		<rect width={twoFactorKey.qr.size} height={twoFactorKey.qr.size} class="light" />
		<path d={twoFactorKey.qr.path} class="dark" />
	</svg>
	<p class="manual">Can’t scan it? Type this key into the app instead (time-based):</p>
	<CopyField value={twoFactorKey.keyText} label="key" />
</div>

<style>
	.key {
		display: grid;
		justify-items: center;
		gap: var(--space-3);
	}

	.steps {
		justify-self: stretch;
		padding-left: var(--space-5);
		color: var(--text-soft);
		font-size: var(--text-sm);
	}

	.qr {
		width: min(220px, 100%);
		height: auto;
		border-radius: var(--radius-inner);
	}

	.light {
		fill: var(--qr-light);
	}

	.dark {
		fill: var(--qr-dark);
	}

	.manual {
		justify-self: stretch;
		color: var(--muted);
		font-size: var(--text-xs);
	}
</style>

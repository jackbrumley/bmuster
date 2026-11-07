<script lang="ts">
	import type { LocalTlsStatus } from '#lib/domain/settings/local-tls.ts';
	import CopyField from '#lib/ui/copy-field.svelte';

	/**
	 * Local network mode on Add machine (SPEC-INSTALL-OPTIONS L5): the pin the
	 * commands below carry, and the fingerprint browsers show, so the admin can
	 * check that this page came from the real server before trusting the pin.
	 */
	let { localTls }: { localTls: LocalTlsStatus } = $props();
</script>

<section class="pin" aria-labelledby="pin-heading">
	<h2 id="pin-heading">Certificate pin (local network mode)</h2>
	{#if localTls.served.kind === 'pin'}
		<p class="hint">
			The commands below carry this pin, so the machine trusts only this server's certificate. Check
			the fingerprint against your browser's certificate details (click the padlock or warning sign
			in the address bar) before you run them.
		</p>
		<p class="label">Pin</p>
		<CopyField value={localTls.served.pin} label="certificate pin" />
		<p class="label">SHA-256 fingerprint (as browsers show it)</p>
		<code class="fingerprint">{localTls.served.fingerprint}</code>
		{#if localTls.restartNeeded}
			<p class="warning">
				A new certificate is waiting for BMuster to restart. Machines enrolled now learn its pin
				automatically.
			</p>
		{/if}
	{:else}
		<p class="warning">
			Local network mode is on, but this server is not serving its own certificate yet. Restart
			BMuster to apply it; until then the commands carry no pin.
		</p>
	{/if}
</section>

<style>
	.pin {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: var(--space-2);
		padding: var(--space-4);
		border-radius: var(--radius-inner);
		background: var(--warning-bg);
	}

	h2 {
		font-size: var(--text-sm);
		font-weight: var(--weight-semibold);
	}

	.label {
		color: var(--muted);
		font-size: var(--text-xs);
		font-weight: var(--weight-medium);
	}

	.hint {
		color: var(--text-soft);
		font-size: var(--text-xs);
	}

	.fingerprint {
		font-family: var(--font-mono);
		font-size: var(--text-xs);
		overflow-wrap: anywhere;
	}

	.warning {
		color: var(--warning);
		font-size: var(--text-sm);
	}
</style>

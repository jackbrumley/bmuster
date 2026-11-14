<script lang="ts">
	import { refreshAll } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { IconShieldCheck } from '@tabler/icons-svelte-runes';
	import type { TwoFactorKey as Key, TwoFactorStatus } from '#lib/domain/auth/two-factor.ts';
	import {
		authenticatorCodeSchema,
		recoveryCodesReplySchema,
		secondStepCodeSchema,
		setUpReplySchema,
		turnedOffReplySchema
	} from '#lib/schemas/auth/two-factor.ts';
	import Button from '#lib/ui/button.svelte';
	import { confirmAction } from '#lib/ui/confirm-action.svelte.ts';
	import LoadingVeil from '#lib/ui/loading-veil.svelte';
	import Modal from '#lib/ui/modal.svelte';
	import Notice from '#lib/ui/notice.svelte';
	import Panel from '#lib/ui/panel.svelte';
	import RecoveryCodes from '#lib/ui/recovery-codes.svelte';
	import TextField from '#lib/ui/text-field.svelte';
	import TwoFactorKey from '#lib/ui/two-factor-key.svelte';
	import { showToast } from '#lib/ui/toast.svelte.ts';
	import { apiRequest } from '#lib/utils/api-client.ts';
	import { formatRelative } from '#lib/utils/format.ts';

	/**
	 * Two-factor sign-in on the Account page (SPEC-TWO-FACTOR 2.6): set it up (QR code, key, first
	 * code and password, then recovery codes once), make new recovery codes, or turn it off.
	 */
	let {
		status,
		email,
		origin,
		now
	}: { status: TwoFactorStatus; email: string; origin: string; now: number } = $props();

	type Dialog =
		| { kind: 'closed' }
		| { kind: 'set-up'; twoFactorKey: Key }
		| { kind: 'new-codes' }
		| { kind: 'turn-off' }
		| { kind: 'codes'; title: string; codes: string[] };

	let dialog = $state<Dialog>({ kind: 'closed' });
	let busy = $state(false);
	let code = $state('');
	let password = $state('');
	let codeError = $state<string | undefined>(undefined);
	let passwordError = $state<string | undefined>(undefined);

	function reset(): void {
		code = '';
		password = '';
		codeError = undefined;
		passwordError = undefined;
	}

	function close(): void {
		const hadCodes = dialog.kind === 'codes';
		dialog = { kind: 'closed' };
		reset();
		if (hadCodes) {
			void refreshAll();
		}
	}

	async function startSetUp(): Promise<void> {
		busy = true;
		const result = await apiRequest({
			method: 'POST',
			url: resolve('/api/account/two-factor/set-up'),
			body: {},
			reply: setUpReplySchema
		});
		busy = false;
		if (!result.ok) {
			showToast(result.message, 'error');
			return;
		}
		reset();
		dialog = { kind: 'set-up', twoFactorKey: result.data.key };
	}

	/** Checks the fields with the server's own rules; true when they can be sent. */
	function fieldsReady(codeRule: 'app' | 'app-or-recovery', needPassword: boolean): boolean {
		const parsed = (codeRule === 'app' ? authenticatorCodeSchema : secondStepCodeSchema).safeParse(
			code
		);
		codeError = parsed.success ? undefined : parsed.error.issues[0]?.message;
		passwordError = needPassword && password === '' ? 'Type your password.' : undefined;
		return codeError === undefined && passwordError === undefined;
	}

	async function turnOn(): Promise<void> {
		if (!fieldsReady('app', true)) {
			return;
		}
		busy = true;
		const result = await apiRequest({
			method: 'POST',
			url: resolve('/api/account/two-factor'),
			body: { code, password },
			reply: recoveryCodesReplySchema
		});
		busy = false;
		if (!result.ok) {
			codeError = result.message;
			return;
		}
		reset();
		showToast('Two-factor sign-in is on.', 'success');
		dialog = {
			kind: 'codes',
			title: 'Two-factor sign-in is on',
			codes: result.data.recoveryCodes
		};
	}

	async function makeNewCodes(): Promise<void> {
		if (!fieldsReady('app', false)) {
			return;
		}
		busy = true;
		const result = await apiRequest({
			method: 'POST',
			url: resolve('/api/account/two-factor/recovery-codes'),
			body: { code },
			reply: recoveryCodesReplySchema
		});
		busy = false;
		if (!result.ok) {
			codeError = result.message;
			return;
		}
		reset();
		dialog = { kind: 'codes', title: 'New recovery codes', codes: result.data.recoveryCodes };
	}

	async function turnOff(): Promise<void> {
		if (!fieldsReady('app-or-recovery', true)) {
			return;
		}
		const yes = await confirmAction({
			title: 'Turn off two-factor sign-in?',
			message:
				'Signing in will need only your password. Your authenticator app’s BMuster entry and your recovery codes stop working.',
			confirmLabel: 'Turn off'
		});
		if (!yes) {
			return;
		}
		busy = true;
		const result = await apiRequest({
			method: 'DELETE',
			url: resolve('/api/account/two-factor'),
			body: { password, code },
			reply: turnedOffReplySchema
		});
		busy = false;
		if (!result.ok) {
			codeError = result.message;
			return;
		}
		close();
		showToast('Two-factor sign-in is off.', 'success');
		await refreshAll();
	}

	const passwordField = {
		label: 'Your password',
		name: 'password',
		type: 'password',
		autocomplete: 'current-password'
	} as const;
</script>

<Panel heading="Two-factor sign-in" actions={undefined} tone="normal" padding="normal">
	{#if status.kind === 'no-password'}
		<p class="text">
			You sign in through {status.providerNames.length > 0
				? status.providerNames.join(', ')
				: 'a sign-in provider'}, which handles two-step checks.
		</p>
	{:else if status.kind === 'off'}
		{#if status.required}
			<Notice tone="warning" title="This server requires two-factor sign-in for you">
				Set it up now. If you don’t, you will be asked to at your next sign-in.
			</Notice>
		{/if}
		<p class="text">
			After your password, BMuster asks for a code from an authenticator app on your phone, so a
			stolen password alone cannot get in.
		</p>
		<div class="actions">
			<Button variant="primary" size="compact" type="button" onclick={() => void startSetUp()}>
				<IconShieldCheck size={18} /> Set up
			</Button>
		</div>
	{:else}
		<p class="text">
			<span class="on">On</span>, turned on {formatRelative(status.sinceIso, now)}.
		</p>
		<p class="text">{`${String(status.recoveryCodesLeft)} of 10 recovery codes left.`}</p>
		{#if status.recoveryCodesLeft <= 3}
			<Notice tone="warning" title="Few recovery codes left">
				Make new recovery codes so you can still sign in if you lose your phone.
			</Notice>
		{/if}
		<div class="actions">
			<Button
				variant="secondary"
				size="compact"
				type="button"
				onclick={() => {
					reset();
					dialog = { kind: 'new-codes' };
				}}
			>
				New recovery codes
			</Button>
			{#if status.required}
				<p class="hint">This server requires it for you, so it cannot be turned off.</p>
			{:else}
				<Button
					variant="danger"
					size="compact"
					type="button"
					onclick={() => {
						reset();
						dialog = { kind: 'turn-off' };
					}}
				>
					Turn off
				</Button>
			{/if}
		</div>
	{/if}
</Panel>

<Modal
	open={dialog.kind !== 'closed'}
	title={dialog.kind === 'set-up'
		? 'Set up two-factor sign-in'
		: dialog.kind === 'new-codes'
			? 'New recovery codes'
			: dialog.kind === 'turn-off'
				? 'Turn off two-factor sign-in'
				: dialog.kind === 'codes'
					? dialog.title
					: ''}
	onclose={close}
>
	<LoadingVeil active={busy} title="Checking" detail={undefined}>
		<div class="body">
			{#if dialog.kind === 'set-up'}
				<TwoFactorKey twoFactorKey={dialog.twoFactorKey} />
				<TextField
					label="Code from your authenticator app"
					name="code"
					type="one-time-code"
					autocomplete="one-time-code"
					autocapitalize="off"
					required={true}
					error={codeError}
					bind:value={code}
				/>
				<TextField
					{...passwordField}
					autocapitalize="off"
					required={true}
					error={passwordError}
					bind:value={password}
				/>
			{:else if dialog.kind === 'new-codes'}
				<p class="text">Your old recovery codes stop working as soon as the new ones are made.</p>
				<TextField
					label="Code from your authenticator app"
					name="code"
					type="one-time-code"
					autocomplete="one-time-code"
					autocapitalize="off"
					required={true}
					error={codeError}
					bind:value={code}
				/>
			{:else if dialog.kind === 'turn-off'}
				<TextField
					{...passwordField}
					autocapitalize="off"
					required={true}
					error={passwordError}
					bind:value={password}
				/>
				<TextField
					label="Code from your authenticator app, or a recovery code"
					name="code"
					type="text"
					autocomplete="one-time-code"
					autocapitalize="off"
					required={true}
					error={codeError}
					bind:value={code}
				/>
			{:else if dialog.kind === 'codes'}
				<RecoveryCodes codes={dialog.codes} {email} {origin} />
			{/if}
		</div>
	</LoadingVeil>
	{#snippet footer()}
		{#if dialog.kind === 'codes'}
			<Button variant="primary" size="compact" type="button" onclick={close}>Done</Button>
		{:else}
			<Button variant="secondary" size="compact" type="button" onclick={close}>Cancel</Button>
			{#if dialog.kind === 'set-up'}
				<Button variant="primary" size="compact" type="button" onclick={() => void turnOn()}>
					Turn on
				</Button>
			{:else if dialog.kind === 'new-codes'}
				<Button variant="primary" size="compact" type="button" onclick={() => void makeNewCodes()}>
					Make new codes
				</Button>
			{:else if dialog.kind === 'turn-off'}
				<Button variant="danger" size="compact" type="button" onclick={() => void turnOff()}>
					Turn off
				</Button>
			{/if}
		{/if}
	{/snippet}
</Modal>

<style>
	.text {
		color: var(--text-soft);
		font-size: var(--text-sm);
	}

	.on {
		color: var(--success);
		font-weight: var(--weight-semibold);
	}

	.actions {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-2);
	}

	.hint {
		color: var(--muted);
		font-size: var(--text-xs);
	}

	.body {
		display: grid;
		gap: var(--space-4);
	}
</style>

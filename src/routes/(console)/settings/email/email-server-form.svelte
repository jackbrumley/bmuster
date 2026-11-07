<script lang="ts">
	import { refreshAll } from '$app/navigation';
	import { page } from '$app/state';
	import Button from '#lib/ui/button.svelte';
	import Checkbox from '#lib/ui/checkbox.svelte';
	import Panel from '#lib/ui/panel.svelte';
	import SegmentedControl from '#lib/ui/segmented-control.svelte';
	import TextField from '#lib/ui/text-field.svelte';
	import { showToast } from '#lib/ui/toast.svelte.ts';
	import { apiRequest } from '#lib/utils/api-client.ts';
	import {
		emailSettingsReplySchema,
		updateEmailSettingsRequestSchema
	} from '#lib/schemas/email/email.ts';
	import {
		EMAIL_SETTING_DEFINITIONS as DEFINITIONS,
		SMTP_SECURITY_OPTIONS,
		type EmailReadiness,
		type EmailSettingsView,
		type SmtpSecurity
	} from '#lib/domain/settings/email-settings-definitions.ts';

	/**
	 * The SMTP settings (SPEC-EMAIL E1), saved together with one button and
	 * checked with the server's own schema first. The password is write-only:
	 * the page shows only whether one is set, and an empty field keeps it.
	 */
	let { settings, readiness }: { settings: EmailSettingsView; readiness: EmailReadiness } =
		$props();

	type TextKey = 'fromName' | 'fromAddress' | 'consoleUrl' | 'smtpHost' | 'smtpUsername';

	/** What the admin has changed since the last save; everything else shows the saved value. */
	type Edits = {
		enabled?: boolean;
		text: Partial<Record<TextKey, string>>;
		port?: string;
		security?: SmtpSecurity;
	};

	let edits = $state<Edits>({ text: {} });
	let newPassword = $state('');
	let clearPassword = $state(false);
	let errors = $state<Partial<Record<string, string>>>({});
	let busy = $state(false);

	const enabled = $derived(edits.enabled ?? settings.enabled);
	const port = $derived(edits.port ?? String(settings.smtpPort));
	const security = $derived(edits.security ?? settings.smtpSecurity);

	function text(key: TextKey): string {
		return edits.text[key] ?? settings[key];
	}

	const ON_OFF: { value: 'on' | 'off'; label: string }[] = [
		{ value: 'on', label: 'On' },
		{ value: 'off', label: 'Off' }
	];

	const status = $derived.by(() => {
		switch (readiness.kind) {
			case 'off':
				return { tone: 'muted', text: 'Off. Nothing is sent.' };
			case 'incomplete':
				return { tone: 'warning', text: `On, but missing: ${readiness.missing.join(', ')}.` };
			case 'ready':
				return { tone: 'success', text: 'On. Emails are sent through the server below.' };
		}
	});

	async function save(): Promise<void> {
		const parsed = updateEmailSettingsRequestSchema.safeParse({
			enabled,
			fromName: text('fromName'),
			fromAddress: text('fromAddress'),
			consoleUrl: text('consoleUrl'),
			smtpHost: text('smtpHost'),
			smtpPort: Number(port.trim() === '' ? Number.NaN : port),
			smtpSecurity: security,
			smtpUsername: text('smtpUsername'),
			smtpPassword: clearPassword
				? { kind: 'clear' }
				: newPassword === ''
					? { kind: 'keep' }
					: { kind: 'replace', value: newPassword }
		});
		if (!parsed.success) {
			errors = Object.fromEntries(
				parsed.error.issues.map((issue) => [String(issue.path[0]), issue.message])
			);
			return;
		}
		errors = {};
		busy = true;
		const result = await apiRequest({
			method: 'PATCH',
			url: '/api/email/settings',
			body: parsed.data,
			reply: emailSettingsReplySchema
		});
		busy = false;
		if (!result.ok) {
			showToast(result.message, 'error');
			return;
		}
		edits = { text: {} };
		newPassword = '';
		clearPassword = false;
		showToast('Email settings are saved.', 'success');
		await refreshAll();
	}
</script>

{#snippet field(key: TextKey, type: 'text' | 'email' | 'url', autocomplete: 'off' | 'email')}
	<div class="field">
		<TextField
			label={DEFINITIONS[key].label}
			name={key}
			{type}
			{autocomplete}
			autocapitalize="off"
			required={false}
			error={errors[key]}
			bind:value={
				() => text(key),
				(typed: string) => {
					edits.text[key] = typed;
				}
			}
		/>
		<p class="hint">{DEFINITIONS[key].description}</p>
	</div>
{/snippet}

<Panel heading="Email server" actions={undefined} tone="normal" padding="normal">
	<p class="status {status.tone}" role="status">{status.text}</p>

	<div class="field">
		<SegmentedControl
			label={DEFINITIONS.enabled.label}
			options={ON_OFF}
			bind:value={
				() => (enabled ? 'on' : 'off'),
				(picked: 'on' | 'off' | null) => {
					edits.enabled = picked === 'on';
				}
			}
		/>
		<p class="hint">{DEFINITIONS.enabled.description}</p>
	</div>

	<div class="grid">
		{@render field('fromName', 'text', 'off')}
		{@render field('fromAddress', 'email', 'email')}
	</div>

	{@render field('consoleUrl', 'url', 'off')}
	{#if text('consoleUrl') === ''}
		<div class="suggest">
			<Button
				variant="secondary"
				size="compact"
				type="button"
				onclick={() => {
					edits.text.consoleUrl = page.url.origin;
				}}
			>
				Use {page.url.origin}
			</Button>
		</div>
	{/if}

	<div class="grid">
		{@render field('smtpHost', 'text', 'off')}
		<div class="field">
			<TextField
				label={DEFINITIONS.smtpPort.label}
				name="smtpPort"
				type="text"
				autocomplete="off"
				autocapitalize="off"
				required={true}
				error={errors['smtpPort']}
				bind:value={
					() => port,
					(typed: string) => {
						edits.port = typed;
					}
				}
			/>
			<p class="hint">{DEFINITIONS.smtpPort.description}</p>
		</div>
	</div>

	<div class="field">
		<SegmentedControl
			label={DEFINITIONS.smtpSecurity.label}
			options={SMTP_SECURITY_OPTIONS}
			bind:value={
				() => security,
				(picked: SmtpSecurity | null) => {
					if (picked !== null) {
						edits.security = picked;
					}
				}
			}
		/>
		<p class="hint">{DEFINITIONS.smtpSecurity.description}</p>
	</div>

	<div class="grid">
		{@render field('smtpUsername', 'text', 'off')}
		<div class="field">
			<TextField
				label="{DEFINITIONS.smtpPassword.label} ({settings.password.kind === 'set'
					? 'Set'
					: 'Not set'})"
				name="smtpPassword"
				type="password"
				autocomplete="new-password"
				autocapitalize="off"
				required={false}
				error={errors['smtpPassword']}
				bind:value={newPassword}
			/>
			<p class="hint">
				{settings.password.kind === 'set'
					? 'Leave empty to keep the saved password.'
					: DEFINITIONS.smtpPassword.description}
			</p>
			{#if settings.password.kind === 'set'}
				<Checkbox
					label="Remove the saved password"
					error={undefined}
					bind:checked={clearPassword}
				/>
			{/if}
		</div>
	</div>

	<div class="actions">
		<Button variant="primary" size="compact" type="button" onclick={() => void save()}>
			{busy ? 'Saving…' : 'Save email settings'}
		</Button>
	</div>
</Panel>

<style>
	.field {
		display: grid;
		gap: var(--space-1);
		min-width: 0;
	}

	.grid {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: var(--space-4);
	}

	@media (min-width: 900px) {
		.grid {
			grid-template-columns: repeat(2, minmax(0, 1fr));
		}
	}

	.hint {
		color: var(--muted);
		font-size: var(--text-xs);
	}

	.suggest,
	.actions {
		display: flex;
		justify-content: flex-end;
	}

	.suggest {
		justify-content: flex-start;
	}

	.status {
		padding: var(--space-2) var(--space-3);
		border-radius: var(--radius-control);
		font-size: var(--text-sm);
	}

	.status.muted {
		background: var(--surface-muted);
		color: var(--text-soft);
	}

	.status.warning {
		background: var(--warning-bg);
		color: var(--warning);
	}

	.status.success {
		background: var(--success-bg);
		color: var(--success);
	}
</style>

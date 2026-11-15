<script lang="ts">
	import { resolve } from '$app/paths';
	import { IconEye } from '@tabler/icons-svelte-runes';
	import type { OsFamily } from '#lib/domain/machines/machine.ts';
	import type { DesktopMode } from '#lib/domain/sessions/session.ts';
	import type { GuestIdentity } from '#lib/domain/share-links/share-links.ts';
	import type { SessionRoute } from '#lib/runes/session-link.svelte.ts';
	import Button from '#lib/ui/button.svelte';
	import TextField from '#lib/ui/text-field.svelte';
	import { guestIdentitySchema } from '#lib/schemas/share-links/share-links.ts';
	import DesktopView from '../../(console)/machines/[id]/desktop/desktop-view.svelte';

	/**
	 * The guest's view of the shared machine's screen (SPEC-SHARE-LINKS SL18):
	 * the console's own desktop view (`desktop-view.svelte`, SPEC-DESKTOP 23)
	 * over the link's guest endpoints, with the same controls within the
	 * link: Watch, or Control when the link allows it, which brings Keys and
	 * copy and paste (SPEC-DESKTOP 21). No file actions (SPEC-SESSION-FILES
	 * question 11). The server and the agent enforce the link's permissions
	 * whatever this page does. Before connecting the guest types their name
	 * (and company, if they like), which the machine's notice and Activity
	 * show (SPEC-SHARE-LINKS D17); the server checks it again.
	 */
	let {
		token,
		machineName,
		osFamily,
		agentVersion,
		canControl
	}: {
		token: string;
		machineName: string;
		osFamily: OsFamily;
		agentVersion: string;
		canControl: boolean;
	} = $props();

	let name = $state('');
	let company = $state('');
	let nameError = $state<string | undefined>(undefined);
	let companyError = $state<string | undefined>(undefined);
	/** Who the guest said they are when they last pressed Watch or Control. */
	let identity: GuestIdentity = { name: '', company: '' };

	function route(): SessionRoute {
		return {
			openUrl: resolve('/s/[token]/session', { token }),
			openBody: (request) => ({ ...request, ...identity }),
			ticket: (sessionId) => ({
				url: resolve('/s/[token]/browser-ticket', { token }),
				body: { sessionId }
			}),
			storageKey: 'bmuster.guest.desktop'
		};
	}

	/** Starts the session once the guest has said who they are. */
	function startAs(mode: DesktopMode, begin: (mode: DesktopMode) => void): void {
		const parsed = guestIdentitySchema.safeParse({ name, company });
		nameError = undefined;
		companyError = undefined;
		if (!parsed.success) {
			for (const issue of parsed.error.issues) {
				if (issue.path[0] === 'name') {
					nameError = issue.message;
				} else {
					companyError = issue.message;
				}
			}
			return;
		}
		identity = parsed.data;
		begin(mode);
	}
</script>

<div class="guest-desktop">
	<DesktopView
		machine={{ id: 'shared-machine', name: machineName, osFamily, agentVersion }}
		route={route()}
		{canControl}
		files={{ kind: 'none', refusal: "Files can't be sent through a share link." }}
		frame={{ kind: 'page', popOutPage: undefined }}
	>
		{#snippet start(begin: (mode: DesktopMode) => void)}
			<div class="who">
				<TextField
					label="Your name"
					name="name"
					type="text"
					autocomplete="name"
					autocapitalize="words"
					required={true}
					error={nameError}
					bind:value={name}
				/>
				<TextField
					label="Company or organisation (optional)"
					name="company"
					type="text"
					autocomplete="off"
					autocapitalize="words"
					required={false}
					error={companyError}
					bind:value={company}
				/>
			</div>
			<div class="choose">
				<Button
					variant="primary"
					size="compact"
					type="button"
					onclick={() => {
						startAs('watch', begin);
					}}><IconEye size={18} /> Watch the screen</Button
				>
				{#if canControl}
					<Button
						variant="secondary"
						size="compact"
						type="button"
						onclick={() => {
							startAs('control', begin);
						}}>Control the screen</Button
					>
				{/if}
			</div>
		{/snippet}
	</DesktopView>
</div>

<style>
	.guest-desktop {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: var(--space-3);
	}

	.who {
		display: grid;
		gap: var(--space-3);
		max-width: 28rem;
	}

	.choose {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-2);
	}
</style>

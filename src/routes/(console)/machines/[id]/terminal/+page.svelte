<script lang="ts">
	import '@xterm/xterm/css/xterm.css';
	import { onMount, tick } from 'svelte';
	import { IconMinus, IconPlugConnected, IconPlus } from '@tabler/icons-svelte-runes';
	import { hasPermission } from '#lib/domain/access/access.ts';
	import { shellsFor } from '#lib/domain/machines/machine.ts';
	import type { TerminalShell } from '#lib/domain/sessions/session.ts';
	import Button from '#lib/ui/button.svelte';
	import ChipGroup from '#lib/ui/chip-group.svelte';
	import { confirmAction } from '#lib/ui/confirm-action.svelte.ts';
	import EmptyState from '#lib/ui/empty-state.svelte';
	import { showToast } from '#lib/ui/toast.svelte.ts';
	import NoPermission from '../no-permission.svelte';
	import ExtraKeys from './extra-keys.svelte';
	import { keySequence, NO_MODIFIERS, withModifiers, type ExtraKeyId } from './extra-keys.ts';
	import { createScreen, type Screen } from './terminal-screen.ts';
	import { TerminalSession } from './terminal-session.svelte.ts';
	import type { PageProps } from './$types';

	/**
	 * The machine's terminal (SPEC-SESSIONS): a shell on the machine in
	 * xterm.js, through the server's relay. Phones get a row of extra keys.
	 * The session runs on the server: a reload comes back to it.
	 */
	let { data }: PageProps = $props();

	const machine = $derived(data.machine);
	const allowed = $derived(hasPermission(data.grants, 'terminal'));
	const shells = $derived(shellsFor(machine.osFamily));

	let host = $state<HTMLElement>();
	let probe = $state<HTMLElement>();
	let keys = $state<HTMLElement>();
	let reserve = $state<HTMLElement>();
	let screen: Screen | undefined;
	let session = $state<TerminalSession>();
	let modifiers = $state(NO_MODIFIERS);
	let picked = $state<TerminalShell | null>(null);
	let now = $state(Date.now());
	let height = $state(420);

	const connection = $derived(session?.connection ?? { kind: 'idle' as const });
	const running = $derived(
		connection.kind === 'live' ||
			connection.kind === 'connecting' ||
			connection.kind === 'starting' ||
			connection.kind === 'reconnecting'
	);
	const shellValue = $derived(picked ?? session?.shell ?? shells[0]?.id ?? null);

	const status = $derived.by(() => {
		switch (connection.kind) {
			case 'idle':
			case 'starting':
			case 'connecting':
				return 'Connecting…';
			case 'live':
				return connection.ready
					? `Session · ${elapsed(now - connection.sinceMs)}`
					: 'Starting the shell…';
			case 'reconnecting':
				return 'Reconnecting…';
			case 'moved':
				return 'Open in another window';
			case 'ended':
				return 'Ended';
		}
	});

	function elapsed(ms: number): string {
		const seconds = Math.max(0, Math.floor(ms / 1000));
		const hours = Math.floor(seconds / 3600);
		const minutes = String(Math.floor((seconds % 3600) / 60)).padStart(2, '0');
		const rest = String(seconds % 60).padStart(2, '0');
		return hours > 0 ? `${hours}:${minutes}:${rest}` : `${minutes}:${rest}`;
	}

	/**
	 * The terminal fills the visible height (above the phone's keyboard when
	 * it is open), leaving room for the extra keys and the tab bar below it.
	 */
	function measure(): void {
		if (host === undefined) {
			return;
		}
		const visible = window.visualViewport?.height ?? window.innerHeight;
		const below = (keys?.offsetHeight ?? 0) + (reserve?.offsetHeight ?? 0);
		const top = Math.min(Math.max(0, host.getBoundingClientRect().top), visible / 2);
		height = Math.round(Math.max(240, Math.min(visible - top - below, 900)));
	}

	// The notice above the terminal comes and goes: keep the terminal inside the screen.
	$effect(() => {
		if (connection.kind !== 'idle') {
			void tick().then(measure);
		}
	});

	function start(shell: TerminalShell): void {
		if (session === undefined || screen === undefined) {
			return;
		}
		const size = screen.size();
		void session.start(shell, size.cols, size.rows);
		screen.focus();
	}

	async function pickShell(shell: TerminalShell | null): Promise<void> {
		if (shell === null || shell === session?.shell) {
			return;
		}
		if (running) {
			const yes = await confirmAction({
				title: `Start ${shell} instead?`,
				message: 'The current session ends, and everything running in it stops.',
				confirmLabel: `End and start ${shell}`
			});
			if (!yes) {
				return;
			}
			session?.end();
		}
		picked = shell;
		start(shell);
	}

	async function endSession(): Promise<void> {
		const yes = await confirmAction({
			title: 'End this session?',
			message: 'The shell on the machine closes, and everything running in it stops.',
			confirmLabel: 'End session'
		});
		if (yes) {
			session?.end();
		}
	}

	function pressKey(key: Exclude<ExtraKeyId, 'ctrl' | 'alt'>): void {
		if (screen === undefined) {
			return;
		}
		const sequence = keySequence(key, modifiers, screen.applicationCursor());
		modifiers = NO_MODIFIERS;
		screen.input(sequence);
	}

	async function paste(): Promise<void> {
		try {
			screen?.paste(await navigator.clipboard.readText());
		} catch {
			showToast('This browser did not allow reading the clipboard. Long-press to paste.', 'error');
		}
	}

	async function copy(text: string): Promise<void> {
		if (text === '') {
			showToast('Select some text in the terminal first.', 'error');
			return;
		}
		try {
			await navigator.clipboard.writeText(text);
			showToast('Copied.', 'success');
		} catch {
			showToast('This browser did not allow copying.', 'error');
		}
	}

	onMount(() => {
		if (
			!allowed ||
			machine.status.kind === 'offline' ||
			host === undefined ||
			probe === undefined
		) {
			return;
		}
		let disposed = false;
		const clock = setInterval(() => {
			now = Date.now();
		}, 1000);
		const viewport = window.visualViewport;
		viewport?.addEventListener('resize', measure);
		window.addEventListener('resize', measure);
		measure();

		void createScreen(host, probe, {
			onData: (input) => {
				const typed = withModifiers(input, modifiers);
				modifiers = NO_MODIFIERS;
				session?.send(typed);
			},
			onResize: (cols, rows) => {
				session?.resize(cols, rows);
			},
			onCopy: (text) => {
				void copy(text);
			}
		}).then(async (created) => {
			if (disposed) {
				created.dispose();
				return;
			}
			screen = created;
			const current = new TerminalSession(machine.id, {
				write: (bytes) => {
					created.write(bytes);
				},
				reset: () => {
					created.reset();
				}
			});
			session = current;
			const size = created.size();
			current.resize(size.cols, size.rows);
			if (!(await current.resume())) {
				start(shells[0]?.id ?? 'sh');
			}
			created.focus();
		});

		return () => {
			disposed = true;
			clearInterval(clock);
			viewport?.removeEventListener('resize', measure);
			window.removeEventListener('resize', measure);
			session?.detach();
			screen?.dispose();
			screen = undefined;
		};
	});
</script>

{#if !allowed}
	<NoPermission />
{:else if machine.status.kind === 'offline'}
	<EmptyState
		icon={IconPlugConnected}
		title="This machine is offline."
		detail="A terminal opens when it checks in again."
		children={undefined}
	/>
{:else}
	<div class="session">
		<div class="bar">
			<ChipGroup
				label="Shell"
				options={shells.map((shell) => ({ value: shell.id, label: shell.label, count: undefined }))}
				bind:value={() => shellValue, (value: TerminalShell | null) => void pickShell(value)}
			/>
			<div class="tools">
				<span class="status" role="status">{status}</span>
				<button
					data-raw-button="icon"
					type="button"
					class="tool"
					aria-label="Smaller text"
					onclick={() => screen?.zoom(-1)}><IconMinus size={16} /></button
				>
				<button
					data-raw-button="icon"
					type="button"
					class="tool"
					aria-label="Bigger text"
					onclick={() => screen?.zoom(1)}><IconPlus size={16} /></button
				>
				{#if running}
					<Button variant="secondary" size="compact" type="button" onclick={() => void endSession()}
						>End</Button
					>
				{/if}
			</div>
		</div>

		{#if connection.kind === 'ended' || connection.kind === 'moved'}
			<div class="notice" role="alert">
				<p>
					{connection.kind === 'ended'
						? connection.message
						: 'This session is open in another window or tab.'}
				</p>
				{#if connection.kind === 'ended'}
					<Button
						variant="primary"
						size="compact"
						type="button"
						onclick={() => {
							start(shellValue ?? 'sh');
						}}>Start a new session</Button
					>
				{:else}
					<Button
						variant="primary"
						size="compact"
						type="button"
						onclick={() => void session?.takeBack()}>Use it here</Button
					>
				{/if}
			</div>
		{/if}

		<div
			class="screen"
			style:height="{height}px"
			aria-label="Terminal on {machine.name}"
			role="region"
		>
			<div class="host" bind:this={host}></div>
		</div>

		<div bind:this={keys}>
			<ExtraKeys
				bind:modifiers
				onkey={pressKey}
				onpaste={() => void paste()}
				oncopy={() => void copy(screen?.selection() ?? '')}
			/>
		</div>
		<span class="probe" aria-hidden="true" bind:this={probe}></span>
		<span class="reserve" aria-hidden="true" bind:this={reserve}></span>
	</div>
{/if}

<style>
	.session {
		position: relative;
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: var(--space-3);
	}

	.bar {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-2) var(--space-3);
	}

	.tools {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		margin-left: auto;
	}

	.status {
		color: var(--muted);
		font-size: var(--text-xs);
		font-variant-numeric: tabular-nums;
		white-space: nowrap;
	}

	.tool {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 40px;
		height: 40px;
		border: 1px solid var(--border);
		border-radius: var(--radius-pill);
		background: var(--surface-elevated);
		color: var(--text-soft);
		cursor: pointer;
	}

	.notice {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-2) var(--space-3);
		padding: var(--space-3) var(--space-4);
		border-radius: var(--radius-control);
		background: var(--surface-muted);
		font-size: var(--text-sm);
	}

	.notice p {
		margin: 0;
	}

	.screen {
		min-height: 240px;
		padding: var(--space-2);
		border-radius: var(--radius-card);
		background: var(--terminal-bg);
		overflow: hidden;
	}

	.host {
		width: 100%;
		height: 100%;
	}

	/* The terminal reads its colours and font from here (terminal-screen.ts). */
	.probe {
		position: absolute;
		top: 0;
		left: 0;
		width: 0;
		height: 0;
		overflow: hidden;
		background: var(--terminal-bg);
		color: var(--terminal-text);
		border-top: 1px solid var(--terminal-prompt);
		outline: 1px solid var(--brand-tint);
		font-family: var(--font-mono);
	}

	/* The space the page keeps under the terminal: the tab bar on phones, a margin on desktops. */
	.reserve {
		position: absolute;
		top: 0;
		left: 0;
		width: 0;
		height: calc(var(--tabbar-height) + var(--safe-bottom) + var(--space-6) + var(--space-3));
		visibility: hidden;
	}

	@media (min-width: 900px) {
		.screen {
			padding: var(--space-3);
		}

		.reserve {
			height: calc(var(--space-8) + var(--space-3));
		}
	}
</style>

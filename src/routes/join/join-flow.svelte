<script lang="ts">
	import type { ScamQuestionId } from '#lib/domain/machines/phone-support.ts';
	import {
		joinCheckReplySchema,
		joinInstallReplySchema,
		joinStopReplySchema,
		type JoinInstallReply
	} from '#lib/schemas/machines/support-codes.ts';
	import { apiRequest } from '#lib/utils/api-client.ts';
	import CodeStep from './code-step.svelte';
	import ConnectedStep from './connected-step.svelte';
	import InstallStep from './install-step.svelte';
	import ScamStep from './scam-step.svelte';
	import StopStep from './stop-step.svelte';

	/**
	 * /join, one step at a time (SPEC-JOIN): the code, who gets access and the
	 * scam check, the command, then Connected. The code stays in this page's
	 * memory only; a reload starts again.
	 */
	let { organisation }: { organisation: string } = $props();

	type Who = {
		code: string;
		supportPerson: string;
		organisation: string;
		impersonators: string;
		reportAdvice: string;
	};

	type Step =
		| { kind: 'code'; problem: string | undefined; busy: boolean }
		| { kind: 'scam'; who: Who }
		| { kind: 'stopped'; who: Who }
		| { kind: 'install'; who: Who; commands: JoinInstallReply; problem: string | undefined }
		| { kind: 'connected'; supportPerson: string };

	let step = $state<Step>({ kind: 'code', problem: undefined, busy: false });

	const POLL_MS = 3000;

	async function check(typed: string): Promise<void> {
		step = { kind: 'code', problem: undefined, busy: true };
		const result = await apiRequest({
			method: 'POST',
			url: '/join/check',
			body: { code: typed },
			reply: joinCheckReplySchema
		});
		if (!result.ok) {
			step = { kind: 'code', problem: result.message, busy: false };
			return;
		}
		switch (result.data.kind) {
			case 'open':
				step = {
					kind: 'scam',
					who: {
						code: typed,
						supportPerson: result.data.supportPerson,
						organisation: result.data.organisation,
						impersonators: result.data.scamWording.impersonators,
						reportAdvice: result.data.scamWording.reportAdvice
					}
				};
				return;
			case 'connected':
				step = { kind: 'connected', supportPerson: result.data.supportPerson };
				return;
		}
	}

	function stop(who: Who, question: ScamQuestionId): void {
		step = { kind: 'stopped', who };
		// Recorded in Activity (J8); the stop screen shows whatever the answer.
		void apiRequest({
			method: 'POST',
			url: '/join/stop',
			body: { code: who.code, question },
			reply: joinStopReplySchema
		});
	}

	async function install(who: Who): Promise<void> {
		const result = await apiRequest({
			method: 'POST',
			url: '/join/install',
			body: { code: who.code, answers: { contacted: 'yes', money: 'no', virus: 'no' } },
			reply: joinInstallReplySchema
		});
		step = result.ok
			? { kind: 'install', who, commands: result.data, problem: undefined }
			: { kind: 'code', problem: result.message, busy: false };
	}

	// Polling is an outside system: while the command shows, ask every few
	// seconds whether the computer has joined. Stops on the first refusal (an
	// expired code), so a stale page never counts as guessing.
	const polling = $derived(step.kind === 'install' && step.problem === undefined ? step.who : null);
	$effect(() => {
		if (polling === null) {
			return;
		}
		const who: Who = polling;
		let stopped = false;
		let timer: ReturnType<typeof setTimeout> | null = null;
		async function poll(): Promise<void> {
			const result = await apiRequest({
				method: 'POST',
				url: '/join/check',
				body: { code: who.code },
				reply: joinCheckReplySchema
			});
			if (stopped || step.kind !== 'install') {
				return;
			}
			if (result.ok && result.data.kind === 'connected') {
				step = { kind: 'connected', supportPerson: result.data.supportPerson };
				return;
			}
			if (!result.ok && result.status !== 0) {
				step = {
					...step,
					problem: `This support code has run out. Ask ${who.supportPerson} for a new one.`
				};
				return;
			}
			timer = setTimeout(() => {
				void poll();
			}, POLL_MS);
		}
		timer = setTimeout(() => {
			void poll();
		}, POLL_MS);
		return () => {
			stopped = true;
			if (timer !== null) {
				clearTimeout(timer);
			}
		};
	});
</script>

{#if step.kind === 'code'}
	<CodeStep
		{organisation}
		problem={step.problem}
		busy={step.busy}
		submit={(typed: string) => void check(typed)}
	/>
{:else if step.kind === 'scam'}
	{@const who = step.who}
	<ScamStep
		supportPerson={who.supportPerson}
		organisation={who.organisation}
		impersonators={who.impersonators}
		stop={(question: ScamQuestionId) => {
			stop(who, question);
		}}
		proceed={() => {
			void install(who);
		}}
	/>
{:else if step.kind === 'stopped'}
	{@const who = step.who}
	<StopStep
		reportAdvice={who.reportAdvice}
		back={() => {
			step = { kind: 'scam', who };
		}}
	/>
{:else if step.kind === 'install'}
	<InstallStep commands={step.commands} supportPerson={step.who.supportPerson} />
	{#if step.problem !== undefined}
		<p class="problem" role="alert">{step.problem}</p>
	{/if}
{:else}
	<ConnectedStep supportPerson={step.supportPerson} />
{/if}

<style>
	.problem {
		margin-top: var(--space-4);
		padding: var(--space-3);
		border-radius: var(--radius-control);
		background: var(--danger-bg);
		color: var(--danger);
		font-size: var(--text-base);
	}
</style>

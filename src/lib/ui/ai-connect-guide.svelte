<script lang="ts">
	import {
		FULL_GUIDE_URL,
		GUIDE_ASSISTANTS,
		guideAssistantLabel,
		guideSteps,
		type GuideAssistant
	} from '#lib/domain/mcp/connect-guide.ts';
	import ChipGroup from './chip-group.svelte';
	import CopyField from './copy-field.svelte';

	/**
	 * How to connect, per assistant (SPEC-MCP M42): pick the assistant, follow its steps with this
	 * server's address filled in. Part of the "Connect an AI assistant" help panel.
	 */
	let { serverUrl }: { serverUrl: string } = $props();

	const options = GUIDE_ASSISTANTS.map((value) => ({
		value,
		label: guideAssistantLabel(value),
		count: undefined
	}));

	let chosen = $state<GuideAssistant | null>('claude-code');

	const steps = $derived(chosen === null ? [] : guideSteps(chosen, serverUrl));
</script>

<h3>How to connect</h3>
<p>This server's MCP address:</p>
<CopyField value={serverUrl} label="MCP server address" />
<ChipGroup label="Your AI assistant" {options} bind:value={chosen} />
<ol>
	{#each steps as step (step.text)}
		<li>
			{step.text}
			{#if step.paste.kind === 'copy'}
				<div class="paste">
					<CopyField value={step.paste.value} label={step.paste.label} />
				</div>
			{/if}
		</li>
	{/each}
</ol>
<ul class="notes">
	<li>Menu names in these apps change often. If one is not there, look for the nearest match.</li>
	<li>
		claude.ai and ChatGPT connect from their own cloud, so this server must be reachable from the
		internet. Terminal and editor tools connect from your computer.
	</li>
	<li>
		Check it worked: ask "list my BMuster machines". It shows in Activity as "&lt;you&gt; via
		&lt;assistant&gt;". Disconnect it from your Account page.
	</li>
</ul>
<p>
	<a href={FULL_GUIDE_URL} target="_blank" rel="external noopener noreferrer">Full guide</a>, with
	the steps for admins, on bmuster.com.
</p>

<style>
	h3 {
		font-size: var(--text-sm);
		font-weight: var(--weight-semibold);
	}

	ol,
	ul {
		display: grid;
		gap: var(--space-2);
		padding-left: var(--space-5);
	}

	ol {
		list-style: decimal;
	}

	li {
		min-width: 0;
	}

	.paste {
		margin-top: var(--space-1);
	}

	.notes {
		list-style: disc;
		color: var(--muted);
	}

	a {
		color: var(--brand);
	}
</style>

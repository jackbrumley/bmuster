<script lang="ts">
	import PageHeader from '#lib/ui/page-header.svelte';
	import SettingsTabs from '../settings-tabs.svelte';
	import EmailServerForm from './email-server-form.svelte';
	import RecentEmails from './recent-emails.svelte';
	import TestEmail from './test-email.svelte';
	import type { PageProps } from './$types';

	/** Settings → Email (SPEC-EMAIL E1–E3, E8). */
	let { data }: PageProps = $props();
</script>

<PageHeader
	title="Settings"
	summary="How this server behaves. Every change is in Activity."
	actions={undefined}
/>

<SettingsTabs />

<EmailServerForm settings={data.settings} readiness={data.readiness} />

<TestEmail defaultTo={data.me.email} />

<RecentEmails emails={data.recent} now={data.now} />

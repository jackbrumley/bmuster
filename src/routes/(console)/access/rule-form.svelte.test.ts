import '../../../app.css';
import { describe, expect, it } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { PERMISSIONS, permissionAbout } from '#lib/domain/access/access.ts';
import RuleForm from './rule-form.svelte';

/** SPEC-MCP M40: the access rule form explains each permission, the two AI ones above all. */
describe('the access rule form (SPEC-MCP M40)', () => {
	it('M40: every permission has a one-line explanation; AI can view and AI commands say how they differ', async () => {
		const screen = await render(RuleForm, {
			userGroups: [{ id: 'people', name: 'IT' }],
			machineGroups: [{ id: 'machines', name: 'Office' }],
			userGroupId: 'people',
			machineGroupId: 'machines',
			permissions: ['view'],
			consent: 'ask',
			error: undefined
		});
		await expect.element(screen.getByRole('checkbox', { name: 'AI can view' })).toBeVisible();
		await expect
			.element(screen.getByRole('checkbox', { name: 'AI commands (with approval)' }))
			.toBeVisible();
		for (const permission of PERMISSIONS) {
			await expect.element(screen.getByText(permissionAbout(permission))).toBeVisible();
		}
		expect(permissionAbout('ai-view')).toMatch(/cannot ask to run/);
		expect(permissionAbout('ai-commands')).toMatch(/approve/);
	});

	it('M40: ticking AI commands ticks AI can view and See inventory', async () => {
		const screen = await render(RuleForm, {
			userGroups: [{ id: 'people', name: 'IT' }],
			machineGroups: [{ id: 'machines', name: 'Office' }],
			userGroupId: 'people',
			machineGroupId: 'machines',
			permissions: [],
			consent: 'ask',
			error: undefined
		});
		await screen.getByRole('checkbox', { name: 'AI commands (with approval)' }).click();
		await expect.element(screen.getByRole('checkbox', { name: 'AI can view' })).toBeChecked();
		await expect.element(screen.getByRole('checkbox', { name: 'See inventory' })).toBeChecked();
	});
});

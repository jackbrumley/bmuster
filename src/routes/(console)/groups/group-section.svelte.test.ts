import { describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { builtInGroupAbout } from '#lib/domain/access/access.ts';
import GroupSection from './group-section.svelte';

vi.mock('$app/navigation', () => ({ refreshAll: () => Promise.resolve() }));

const EARLY = '00000000-0000-4000-8000-0000000ea51e';
const MACHINE = '11111111-1111-4111-8111-111111111111';

function renderSection(opened: string | undefined) {
	return render(GroupSection, {
		kind: 'machine',
		title: 'Machines',
		nouns: { one: 'machine', many: 'machines' },
		groups: [
			{
				id: EARLY,
				name: 'Early updates',
				description: 'New agent versions reach these machines first.',
				about: builtInGroupAbout('early'),
				membership: { kind: 'chosen', memberIds: [MACHINE] }
			},
			{
				id: '22222222-2222-4222-8222-222222222222',
				name: 'Office',
				description: '',
				about: undefined,
				membership: { kind: 'chosen', memberIds: [] }
			}
		],
		candidates: [{ id: MACHINE, label: 'Reception PC', detail: '' }],
		opened,
		rulesUsing: () => []
	});
}

describe('Groups page, machines (SPEC-ACCESS A11)', () => {
	it('A11: marks Early updates as built in, and only the groups people made', async () => {
		const screen = await renderSection(undefined);
		expect(screen.getByText('Built in').all()).toHaveLength(1);
	});

	it('A11: opens a linked group, says what it does, and offers its machines but not Edit or Delete', async () => {
		const screen = await renderSection(EARLY);
		const dialog = screen.getByRole('dialog');
		await expect
			.element(dialog.getByText(/new agent versions reach these machines first, an hour/))
			.toBeVisible();
		await expect.element(dialog.getByText('Reception PC')).toBeVisible();
		await expect.element(dialog.getByRole('button', { name: 'Machines' })).toBeVisible();
		expect(dialog.getByRole('button', { name: 'Edit' }).all()).toHaveLength(0);
		expect(dialog.getByRole('button', { name: 'Delete' }).all()).toHaveLength(0);
	});
});

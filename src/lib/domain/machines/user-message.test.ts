import { describe, expect, it } from 'vitest';
import type { Grant } from '#lib/domain/access/access.ts';
import { canSendUserMessage } from './user-message.ts';

const grant = (permission: Grant['permission']): Grant => ({ permission, consent: 'unattended' });

describe('who may send a message to the person at a machine', () => {
	it('needs desktop control or a terminal, not just watching', () => {
		expect(canSendUserMessage([grant('view'), grant('desktop-control')], 'windows')).toBe(true);
		expect(canSendUserMessage([grant('view'), grant('terminal')], 'windows')).toBe(true);
		expect(canSendUserMessage([grant('view'), grant('desktop-view')], 'windows')).toBe(false);
		expect(canSendUserMessage([grant('view')], 'windows')).toBe(false);
	});

	it('is Windows only for now', () => {
		expect(canSendUserMessage([grant('terminal')], 'linux')).toBe(false);
		expect(canSendUserMessage([grant('terminal')], 'macos')).toBe(false);
	});
});

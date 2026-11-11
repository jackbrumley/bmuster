import { describe, expect, it } from 'vitest';
import type { ServerUpdateView } from '#lib/schemas/releases/server-updates.ts';
import { showsUpdateNotice } from './server-update-notice.ts';

type Phase = ServerUpdateView['operation']['phase'];

function view(phase: Phase, release: boolean): ServerUpdateView {
	return {
		installedVersion: '0.4.14',
		deployment: 'installed',
		checkedAtIso: '2026-11-11T08:00:00.000Z',
		lastSuccessAtIso: '2026-11-11T08:00:00.000Z',
		release: release
			? {
					version: '0.4.15',
					notes: '',
					publishedAtIso: '2026-11-11T08:00:00.000Z',
					manifest: {
						schemaVersion: 1,
						version: '0.4.15',
						target: 'x86_64-unknown-linux-gnu',
						archive: 'bmuster-server-0.4.15.tar.gz',
						bytes: 1,
						sha256: 'a'.repeat(64),
						minimumLauncher: '0.4.1',
						nodeMajor: 26,
						rollbackFrom: []
					}
				}
			: null,
		problem: null,
		install: { allowed: true, reason: '' },
		operation: { phase, from: null, to: null, message: '', atIso: null }
	};
}

describe('the update-available notice (SPEC-SERVER-UPDATES SU13)', () => {
	it('SU13: shows when a release waits and nothing is updating', () => {
		for (const phase of ['idle', 'up-to-date', 'healthy', 'rolled-back', 'failed'] as const) {
			expect(showsUpdateNotice(view(phase, true), 'other'), phase).toBe(true);
		}
	});

	it('SU13: hides while an update is requested or running', () => {
		for (const phase of [
			'requested',
			'checking',
			'downloading',
			'switching',
			'starting'
		] as const) {
			expect(showsUpdateNotice(view(phase, true), 'other'), phase).toBe(false);
		}
	});

	it('SU13: hides on the Updates page, with no release, and for people who cannot update', () => {
		expect(showsUpdateNotice(view('idle', true), 'updates')).toBe(false);
		expect(showsUpdateNotice(view('idle', false), 'other')).toBe(false);
		expect(showsUpdateNotice(null, 'other')).toBe(false);
	});
});

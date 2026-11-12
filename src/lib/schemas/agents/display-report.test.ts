import { describe, expect, it } from 'vitest';
import { displayReportSchema } from './display-report.ts';

const linuxReport = {
	kind: 'linux',
	seat: { kind: 'none' },
	cards: [],
	uinput: { device: true, module: true },
	nvidiaModeset: { kind: 'absent' },
	programs: { xdgDesktopPortal: true, gstreamer: true, pipewiresrc: true },
	kernel: '7.2.5-200.fc44.x86_64',
	agentVersion: '0.4.1',
	launcherVersion: { kind: 'none' }
};

describe('display report schema', () => {
	it('reads a 0.4.1 report without SELinux as unreported', () => {
		const report = displayReportSchema.parse(linuxReport);
		expect(report.kind === 'linux' ? report.selinux : undefined).toEqual({ kind: 'unreported' });
	});

	it('reads the SELinux mode and contexts', () => {
		const selinux = {
			kind: 'present',
			enforcing: true,
			agentContext: 'system_u:system_r:unconfined_service_t:s0',
			initContext: 'system_u:system_r:init_t:s0'
		};
		const report = displayReportSchema.parse({ ...linuxReport, selinux });
		expect(report.kind === 'linux' ? report.selinux : undefined).toEqual(selinux);
	});

	it('D8: reads a Windows report before 0.4.3 as unreported, and the new fields after', () => {
		const older = displayReportSchema.parse({ kind: 'windows', console: { kind: 'none' } });
		expect(older.kind === 'windows' ? older.system : undefined).toEqual({ kind: 'unreported' });
		const system = {
			kind: 'reported',
			build: '26100.2314',
			edition: 'Professional',
			consoleSession: { kind: 'attached', id: 1, state: 'active' },
			secureDesktop: { kind: 'unknown' },
			outputs: {
				kind: 'read',
				list: [{ adapter: 'GPU', name: '\\\\.\\DISPLAY1', width: 1920, height: 1080, rotation: 0 }]
			},
			sasPolicy: { kind: 'not-set' }
		};
		const report = displayReportSchema.parse({
			kind: 'windows',
			console: { kind: 'none' },
			system
		});
		expect(report.kind === 'windows' ? report.system : undefined).toEqual(system);
	});

	it('DW4: reads the console outputs, a failure with its reason, and an older bare list', () => {
		const outputsOf = (outputs: unknown) => {
			const report = displayReportSchema.parse({
				kind: 'windows',
				console: { kind: 'none' },
				system: {
					kind: 'reported',
					build: '19045.6456',
					edition: 'Professional',
					consoleSession: { kind: 'attached', id: 1, state: 'active' },
					secureDesktop: { kind: 'unknown' },
					outputs,
					sasPolicy: { kind: 'not-set' }
				}
			});
			return report.kind === 'windows' && report.system.kind === 'reported'
				? report.system.outputs
				: undefined;
		};
		const failed = { kind: 'failed', reason: 'No session is attached to the console.' };
		expect(outputsOf(failed)).toEqual(failed);
		expect(outputsOf([])).toEqual({ kind: 'service-session', list: [] });
		// What the server stored from an older agent reads back the same.
		expect(outputsOf({ kind: 'service-session', list: [] })).toEqual({
			kind: 'service-session',
			list: []
		});
		expect(() => outputsOf({ kind: 'failed', reason: 'x'.repeat(501) })).toThrow();
	});
});

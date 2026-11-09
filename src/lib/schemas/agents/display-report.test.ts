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
});

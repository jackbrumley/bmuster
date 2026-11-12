import { describe, expect, it } from 'vitest';
import type { Machine, MachineInventory } from '#lib/domain/machines/machine.ts';
import { TEST_MACHINE } from '#tests/helpers/machines.ts';
import { OLDEST_CONPTY_BUILD, windowsPtyFor } from './windows-pty.ts';

function windowsWith(osBuild: string | undefined): Machine {
	const inventory: MachineInventory =
		osBuild === undefined
			? { kind: 'pending' }
			: {
					kind: 'known',
					osName: 'Windows 11 Pro',
					osVersion: '11',
					osBuild,
					updates: { kind: 'unknown' },
					cpuModel: '',
					cpuCores: 4,
					memoryTotalBytes: 0,
					disks: [],
					network: [],
					gpus: [],
					display: { kind: 'unreported' },
					power: { kind: 'unreported' }
				};
	return { ...TEST_MACHINE, osFamily: 'windows', inventory };
}

describe('T10: xterm.js is told about ConPTY on Windows machines', () => {
	it('uses the build number from the inventory', () => {
		expect(windowsPtyFor(windowsWith('22631'))).toEqual({ backend: 'conpty', buildNumber: 22631 });
		expect(windowsPtyFor(windowsWith('10.0.19045.4529'))).toEqual({
			backend: 'conpty',
			buildNumber: 19045
		});
	});

	it('assumes the oldest ConPTY build until the inventory says', () => {
		expect(windowsPtyFor(windowsWith(undefined))).toEqual({
			backend: 'conpty',
			buildNumber: OLDEST_CONPTY_BUILD
		});
		expect(windowsPtyFor(windowsWith(''))).toEqual({
			backend: 'conpty',
			buildNumber: OLDEST_CONPTY_BUILD
		});
	});

	it('tells xterm.js nothing for Linux and macOS, whose PTYs leave reflowing to it', () => {
		expect(windowsPtyFor(TEST_MACHINE)).toBeUndefined();
		expect(windowsPtyFor({ ...TEST_MACHINE, osFamily: 'macos' })).toBeUndefined();
	});
});

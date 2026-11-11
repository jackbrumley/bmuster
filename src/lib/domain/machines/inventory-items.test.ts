import { describe, expect, it } from 'vitest';
import { adapterItem, gpuItem, itemText } from './inventory-items.ts';

describe('inventory items (SPEC-MACHINE-DETAILS D10, D11)', () => {
	it('D10: an adapter shows its MAC address and addresses', () => {
		const item = adapterItem({
			name: 'eth0',
			mac: '00:11:22:33:44:55',
			addresses: ['10.0.0.5', 'fe80::1']
		});
		expect(item).toEqual({ title: 'eth0', detail: 'MAC 00:11:22:33:44:55 · 10.0.0.5, fe80::1' });
		expect(itemText(item)).toBe('eth0: MAC 00:11:22:33:44:55 · 10.0.0.5, fe80::1');
	});

	it('D10: leaves out a missing or all-zero MAC address', () => {
		expect(
			adapterItem({ name: 'tun0', mac: '00:00:00:00:00:00', addresses: ['10.8.0.2'] })
		).toEqual({ title: 'tun0', detail: '10.8.0.2' });
		expect(adapterItem({ name: 'wg0', mac: '', addresses: [] }).detail).toBe('No addresses');
	});

	it('D11: a graphics card shows its vendor and driver', () => {
		expect(
			gpuItem({
				name: 'NVIDIA GeForce RTX 4070',
				vendor: 'NVIDIA Corporation',
				memoryBytes: { kind: 'known', bytes: 12 * 1024 ** 3 },
				driver: 'nvidia 550.54'
			})
		).toEqual({
			title: 'NVIDIA GeForce RTX 4070 (12 GB)',
			detail: 'NVIDIA Corporation · driver nvidia 550.54'
		});
		expect(
			gpuItem({ name: 'Mystery', vendor: '', memoryBytes: { kind: 'unknown' }, driver: '' })
		).toEqual({ title: 'Mystery', detail: 'driver not reported' });
	});
});

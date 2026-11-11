/**
 * The rows of Overview's Graphics and Network cards (SPEC-MACHINE-DETAILS D10, D11), shared with
 * the Machines export (SPEC-CSV-EXPORT X13) so the file reads as the screen does. Browser-safe.
 */
import { gpuLabel, type Gpu, type NetworkAdapter } from './machine.ts';

export type InventoryItem = { title: string; detail: string };

/** Systems report a missing MAC address as '' or as all zeros. */
function hasMac(mac: string): boolean {
	return /[1-9a-f]/i.test(mac);
}

/** "eth0" / "MAC 00:11:22:33:44:55 · 10.0.0.5, fe80::1". */
export function adapterItem(adapter: NetworkAdapter): InventoryItem {
	const addresses = adapter.addresses.length > 0 ? adapter.addresses.join(', ') : 'No addresses';
	return {
		title: adapter.name,
		detail: hasMac(adapter.mac) ? `MAC ${adapter.mac} · ${addresses}` : addresses
	};
}

/** "NVIDIA GeForce RTX 4070 (12 GB)" / "NVIDIA Corporation · driver nvidia 550.54". */
export function gpuItem(gpu: Gpu): InventoryItem {
	const driver = gpu.driver === '' ? 'driver not reported' : `driver ${gpu.driver}`;
	return {
		title: gpuLabel(gpu),
		detail: gpu.vendor === '' ? driver : `${gpu.vendor} · ${driver}`
	};
}

/** One item in an export cell: "eth0: MAC 00:11:22:33:44:55 · 10.0.0.5". */
export function itemText(item: InventoryItem): string {
	return `${item.title}: ${item.detail}`;
}

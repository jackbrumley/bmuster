import { closeSync, openSync, readSync } from 'node:fs';

export function readBounded(path: string, limit: number): Buffer {
	const fd = openSync(path, 'r');
	try {
		const bytes = Buffer.alloc(limit + 1);
		let size = 0;
		while (size < bytes.length) {
			const read = readSync(fd, bytes, size, bytes.length - size, null);
			if (read === 0) break;
			size += read;
		}
		if (size > limit) throw new Error(`Update control file exceeds ${String(limit)} bytes.`);
		return bytes.subarray(0, size);
	} finally {
		closeSync(fd);
	}
}

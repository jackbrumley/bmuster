import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { zipLength, zipStream, type ZipEntry } from './zip-stream.ts';

// SPEC-SESSION-FILES SF25: several files as one streamed, stored ZIP64.

function entry(name: string, data: Uint8Array, pieces = 3): ZipEntry {
	return {
		name,
		size: data.byteLength,
		modifiedMs: Date.UTC(2026, 10, 15, 10, 30, 0),
		bytes: async function* () {
			const step = Math.max(1, Math.ceil(data.byteLength / pieces));
			for (let at = 0; at < data.byteLength; at += step) {
				await Promise.resolve();
				yield data.subarray(at, at + step);
			}
		}
	};
}

async function collect(entries: ZipEntry[]): Promise<Uint8Array> {
	const parts: Uint8Array[] = [];
	for await (const part of zipStream(entries)) parts.push(part);
	return new Uint8Array(Buffer.concat(parts));
}

/** Runs a system tool, or says it is missing (the test then checks with the others). */
function tool(command: string, args: string[]): string | undefined {
	try {
		return execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
	} catch (error) {
		if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
		throw error;
	}
}

describe('the streamed zip', () => {
	it('SF25: unzips byte-exact with Info-ZIP, 7-Zip and Python, folders and UTF-8 names kept', async () => {
		const big = new Uint8Array(300_000).map((_, i) => (i * 31) % 251);
		const files: [string, Uint8Array][] = [
			['report.pdf', new TextEncoder().encode('%PDF-1.7 hello')],
			['Photos/Téléchargé ü.jpg', big],
			['Photos/empty.txt', new Uint8Array(0)],
			['SKIPPED.txt', new TextEncoder().encode('Photos/link: a link (links are not followed)\n')]
		];
		const zip = await collect(files.map(([name, data]) => entry(name, data)));
		expect(zip.byteLength).toBe(
			zipLength(files.map(([name, data]) => ({ name, size: data.byteLength })))
		);
		const dir = mkdtempSync(join(tmpdir(), 'bmuster-zip-'));
		try {
			const path = join(dir, 'files.zip');
			writeFileSync(path, zip);
			let checked = 0;
			const infoZip = tool('unzip', ['-t', path]);
			if (infoZip !== undefined) {
				expect(infoZip).toContain('No errors detected');
				checked += 1;
			}
			const sevenZip = tool('7z', ['t', path]);
			if (sevenZip !== undefined) {
				expect(sevenZip).toContain('Everything is Ok');
				checked += 1;
			}
			const out = join(dir, 'out');
			const python = tool('python3', [
				'-I',
				'-c',
				'import sys, zipfile; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])',
				path,
				out
			]);
			if (python !== undefined) {
				for (const [name, data] of files) {
					expect(new Uint8Array(readFileSync(join(out, name)))).toEqual(data);
				}
				checked += 1;
			}
			expect(checked).toBeGreaterThan(0);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it('SF25: a file that changes size while it is read ends the download', async () => {
		const short: ZipEntry = { ...entry('a.txt', new Uint8Array(5)), size: 10 };
		await expect(collect([short])).rejects.toThrow('a.txt changed while it was downloading.');
	});
});

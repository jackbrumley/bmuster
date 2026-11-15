import { crc32 } from 'node:zlib';

/**
 * Several files from the machine as one download (SPEC-SESSION-FILES 3.2, SF25): a stored
 * (uncompressed) ZIP64 written as the files' bytes arrive, nothing held but the piece in hand.
 * Every entry carries its sizes up front (the walk knows them) and its CRC-32 in a data
 * descriptor after the data, so the server never needs to look back. Names are UTF-8 (flag
 * 11). Windows Explorer, macOS Archive Utility and Info-ZIP read this form.
 */

export type ZipEntry = {
	/** The path inside the zip, `/`-separated. */
	name: string;
	size: number;
	modifiedMs: number;
	/** The entry's bytes, exactly `size` of them. */
	bytes: () => AsyncIterable<Uint8Array>;
};

const UTF8_AND_DESCRIPTOR = 0x0808;
const ZIP64_VERSION = 45;
const MAX32 = 0xffff_ffff;
const MAX16 = 0xffff;

function encode(name: string): Uint8Array {
	return new TextEncoder().encode(name);
}

/** The MS-DOS time and date fields (2-second steps, from 1980). */
function dosTime(ms: number): { time: number; date: number } {
	const at = new Date(Math.max(ms, Date.UTC(1980, 0, 1)));
	return {
		time: (at.getHours() << 11) | (at.getMinutes() << 5) | Math.floor(at.getSeconds() / 2),
		date: ((at.getFullYear() - 1980) << 9) | ((at.getMonth() + 1) << 5) | at.getDate()
	};
}

class Writer {
	readonly bytes: Uint8Array;
	readonly #view: DataView;
	#at = 0;

	constructor(size: number) {
		this.bytes = new Uint8Array(size);
		this.#view = new DataView(this.bytes.buffer);
	}

	u16(value: number): this {
		this.#view.setUint16(this.#at, value, true);
		this.#at += 2;
		return this;
	}

	u32(value: number): this {
		this.#view.setUint32(this.#at, value >>> 0, true);
		this.#at += 4;
		return this;
	}

	u64(value: number): this {
		this.#view.setBigUint64(this.#at, BigInt(value), true);
		this.#at += 8;
		return this;
	}

	raw(data: Uint8Array): this {
		this.bytes.set(data, this.#at);
		this.#at += data.byteLength;
		return this;
	}
}

function localHeader(name: Uint8Array, entry: ZipEntry): Uint8Array {
	const { time, date } = dosTime(entry.modifiedMs);
	return new Writer(30 + name.byteLength + 20)
		.u32(0x04034b50)
		.u16(ZIP64_VERSION)
		.u16(UTF8_AND_DESCRIPTOR)
		.u16(0)
		.u16(time)
		.u16(date)
		.u32(0)
		.u32(MAX32)
		.u32(MAX32)
		.u16(name.byteLength)
		.u16(20)
		.raw(name)
		.u16(0x0001)
		.u16(16)
		.u64(entry.size)
		.u64(entry.size).bytes;
}

function descriptor(crc: number, size: number): Uint8Array {
	return new Writer(24).u32(0x08074b50).u32(crc).u64(size).u64(size).bytes;
}

function centralEntry(name: Uint8Array, entry: ZipEntry, crc: number, offset: number): Uint8Array {
	const { time, date } = dosTime(entry.modifiedMs);
	return new Writer(46 + name.byteLength + 28)
		.u32(0x02014b50)
		.u16(ZIP64_VERSION)
		.u16(ZIP64_VERSION)
		.u16(UTF8_AND_DESCRIPTOR)
		.u16(0)
		.u16(time)
		.u16(date)
		.u32(crc)
		.u32(MAX32)
		.u32(MAX32)
		.u16(name.byteLength)
		.u16(28)
		.u16(0)
		.u16(0)
		.u16(0)
		.u32(0)
		.u32(MAX32)
		.raw(name)
		.u16(0x0001)
		.u16(24)
		.u64(entry.size)
		.u64(entry.size)
		.u64(offset).bytes;
}

function ending(count: number, centralSize: number, centralOffset: number): Uint8Array {
	const zip64End = centralOffset + centralSize;
	return new Writer(56 + 20 + 22)
		.u32(0x06064b50)
		.u64(44)
		.u16(ZIP64_VERSION)
		.u16(ZIP64_VERSION)
		.u32(0)
		.u32(0)
		.u64(count)
		.u64(count)
		.u64(centralSize)
		.u64(centralOffset)
		.u32(0x07064b50)
		.u32(0)
		.u64(zip64End)
		.u32(1)
		.u32(0x06054b50)
		.u16(0)
		.u16(0)
		.u16(MAX16)
		.u16(MAX16)
		.u32(MAX32)
		.u32(MAX32)
		.u16(0).bytes;
}

/** The zip's length in bytes, known before anything is read. */
export function zipLength(entries: readonly { name: string; size: number }[]): number {
	let total = 98;
	for (const entry of entries) {
		const name = encode(entry.name).byteLength;
		total += 30 + name + 20 + entry.size + 24 + 46 + name + 28;
	}
	return total;
}

/**
 * The zip, piece by piece. An entry that yields more or fewer bytes than its size throws: the
 * file changed on the machine, and the download ends rather than holding a wrong file.
 */
export async function* zipStream(entries: readonly ZipEntry[]): AsyncGenerator<Uint8Array> {
	let offset = 0;
	const central: Uint8Array[] = [];
	for (const entry of entries) {
		const name = encode(entry.name);
		const header = localHeader(name, entry);
		const at = offset;
		yield header;
		offset += header.byteLength;
		let crc = 0;
		let seen = 0;
		for await (const piece of entry.bytes()) {
			crc = crc32(piece, crc);
			seen += piece.byteLength;
			if (seen > entry.size) {
				throw new Error(`${entry.name} changed while it was downloading.`);
			}
			yield piece;
		}
		if (seen !== entry.size) {
			throw new Error(`${entry.name} changed while it was downloading.`);
		}
		offset += seen;
		const trailer = descriptor(crc, seen);
		yield trailer;
		offset += trailer.byteLength;
		central.push(centralEntry(name, entry, crc, at));
	}
	const centralOffset = offset;
	let centralSize = 0;
	for (const record of central) {
		yield record;
		centralSize += record.byteLength;
	}
	yield ending(central.length, centralSize, centralOffset);
}

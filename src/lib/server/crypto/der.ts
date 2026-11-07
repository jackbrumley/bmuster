/**
 * The few DER (ASN.1) encodings an X.509 certificate needs. Node can sign and
 * parse certificates but not build them, and this is small enough to keep in
 * the open instead of pulling in a certificate library.
 */

function lengthBytes(length: number): Buffer {
	if (length < 0x80) {
		return Buffer.from([length]);
	}
	const bytes: number[] = [];
	for (let rest = length; rest > 0; rest = Math.floor(rest / 256)) {
		bytes.unshift(rest % 256);
	}
	return Buffer.from([0x80 | bytes.length, ...bytes]);
}

/** One element: tag, length, contents. */
function derElement(tag: number, contents: Buffer): Buffer {
	return Buffer.concat([Buffer.from([tag]), lengthBytes(contents.length), contents]);
}

export function derSequence(...items: Buffer[]): Buffer {
	return derElement(0x30, Buffer.concat(items));
}

export function derSet(...items: Buffer[]): Buffer {
	return derElement(0x31, Buffer.concat(items));
}

/** A non-negative integer from its big-endian bytes (a leading zero keeps it positive). */
export function derUnsignedInteger(bytes: Buffer): Buffer {
	let start = 0;
	while (start < bytes.length - 1 && bytes[start] === 0) {
		start += 1;
	}
	const trimmed = bytes.subarray(start);
	const first = trimmed[0] ?? 0;
	return derElement(0x02, first >= 0x80 ? Buffer.concat([Buffer.from([0]), trimmed]) : trimmed);
}

export function derSmallInteger(value: number): Buffer {
	if (!Number.isInteger(value) || value < 0 || value > 127) {
		throw new Error(`derSmallInteger takes 0 to 127, not ${value}`);
	}
	return derElement(0x02, Buffer.from([value]));
}

export function derBoolean(value: boolean): Buffer {
	return derElement(0x01, Buffer.from([value ? 0xff : 0x00]));
}

/** An object identifier from its dotted form, e.g. `2.5.4.3`. */
export function derObjectId(dotted: string): Buffer {
	const parts = dotted.split('.').map((part) => Number.parseInt(part, 10));
	const [first, second, ...rest] = parts;
	if (first === undefined || second === undefined) {
		throw new Error(`Not an object identifier: ${dotted}`);
	}
	const bytes: number[] = [first * 40 + second];
	for (const part of rest) {
		const chunk: number[] = [part % 128];
		for (let value = Math.floor(part / 128); value > 0; value = Math.floor(value / 128)) {
			chunk.unshift((value % 128) | 0x80);
		}
		bytes.push(...chunk);
	}
	return derElement(0x06, Buffer.from(bytes));
}

export function derUtf8String(text: string): Buffer {
	return derElement(0x0c, Buffer.from(text, 'utf8'));
}

export function derOctetString(bytes: Buffer): Buffer {
	return derElement(0x04, bytes);
}

/** A bit string whose bits fill whole bytes, except `unusedBits` at the end. */
export function derBitString(bytes: Buffer, unusedBits: number): Buffer {
	return derElement(0x03, Buffer.concat([Buffer.from([unusedBits]), bytes]));
}

/** RFC 5280 4.1.2.5: UTCTime up to 2049, GeneralizedTime from 2050. */
export function derTime(date: Date): Buffer {
	const iso = date.toISOString();
	const digits = `${iso.slice(0, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)}Z`;
	return date.getUTCFullYear() < 2050
		? derElement(0x17, Buffer.from(digits.slice(2), 'ascii'))
		: derElement(0x18, Buffer.from(digits, 'ascii'));
}

/** `[n] EXPLICIT`: a constructed context tag around a whole element. */
export function derExplicit(tagNumber: number, element: Buffer): Buffer {
	return derElement(0xa0 | tagNumber, element);
}

/** `[n] IMPLICIT` on a primitive value: the context tag replaces the value's own tag. */
export function derImplicitPrimitive(tagNumber: number, contents: Buffer): Buffer {
	return derElement(0x80 | tagNumber, contents);
}

/**
 * The desktop's binary frames (SPEC-DESKTOP 4.1, 4.2), as the browser reads
 * them. Browser-safe and pure. The agent writes them in
 * agent/crates/desktop/src/frame.rs; the golden files in
 * tests/fixtures/desktop-frames prove both sides agree.
 */

export const FORMAT_VERSION = 1;
export const HEADER_LENGTH = 20;

/** Header flags (byte 2). Bit 1, size changed, needs nothing here: every frame carries its size. */
export const FLAG_KEYFRAME = 1;
export const FLAG_LAST_PART = 4;

export type FrameHeader = {
	type: number;
	display: number;
	flags: number;
	version: number;
	seq: number;
	/** Capture time, microseconds since the session started. */
	pts: number;
	/** The encoded frame's size (after scaling). */
	width: number;
	height: number;
};

type TileFormat = 'jpeg' | 'webp' | 'solid';

export type Tile = {
	x: number;
	y: number;
	w: number;
	h: number;
	format: TileFormat;
	/** The image, or for a solid tile its colour as red, green, blue, alpha. */
	bytes: Uint8Array;
};

export type DesktopFrame =
	| { kind: 'h264'; header: FrameHeader; data: Uint8Array }
	| { kind: 'tiles'; header: FrameHeader; tiles: Tile[] }
	| {
			kind: 'cursor-shape';
			header: FrameHeader;
			id: number;
			hotspotX: number;
			hotspotY: number;
			png: Uint8Array;
	  }
	| {
			kind: 'cursor-position';
			header: FrameHeader;
			id: number;
			x: number;
			y: number;
			visible: boolean;
	  };

export type ParsedFrame =
	| { kind: 'frame'; frame: DesktopFrame }
	/** `version` set when the agent speaks another format version: the session must end. */
	| { kind: 'bad'; message: string; wrongVersion: boolean };

function bad(message: string): ParsedFrame {
	return { kind: 'bad', message, wrongVersion: false };
}

function tileFormat(code: number): TileFormat | undefined {
	switch (code) {
		case 1:
			return 'jpeg';
		case 2:
			return 'webp';
		case 3:
			return 'solid';
		default:
			return undefined;
	}
}

function readHeader(view: DataView): FrameHeader {
	return {
		type: view.getUint8(0),
		display: view.getUint8(1),
		flags: view.getUint8(2),
		version: view.getUint8(3),
		seq: view.getUint32(4, true),
		pts: Number(view.getBigUint64(8, true)),
		width: view.getUint16(16, true),
		height: view.getUint16(18, true)
	};
}

function readTiles(view: DataView, bytes: Uint8Array): Tile[] | string {
	if (view.byteLength < HEADER_LENGTH + 2) {
		return 'a tile batch without its count';
	}
	const count = view.getUint16(HEADER_LENGTH, true);
	const tiles: Tile[] = [];
	let at = HEADER_LENGTH + 2;
	for (let index = 0; index < count; index += 1) {
		if (at + 13 > view.byteLength) {
			return `tile ${index} is cut short`;
		}
		const length = view.getUint32(at + 9, true);
		const format = tileFormat(view.getUint8(at + 8));
		if (format === undefined) {
			return `tile ${index} has an unknown format`;
		}
		if (at + 13 + length > view.byteLength) {
			return `tile ${index} is cut short`;
		}
		tiles.push({
			x: view.getUint16(at, true),
			y: view.getUint16(at + 2, true),
			w: view.getUint16(at + 4, true),
			h: view.getUint16(at + 6, true),
			format,
			bytes: bytes.subarray(at + 13, at + 13 + length)
		});
		at += 13 + length;
	}
	return tiles;
}

/** Reads one binary message from the agent. */
export function parseFrame(bytes: Uint8Array): ParsedFrame {
	if (bytes.byteLength < HEADER_LENGTH) {
		return bad('a frame shorter than its header');
	}
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const header = readHeader(view);
	if (header.version !== FORMAT_VERSION) {
		return {
			kind: 'bad',
			message: `This machine sends desktop format ${header.version}; this console reads format ${FORMAT_VERSION}. Update the agent or the server.`,
			wrongVersion: true
		};
	}
	switch (header.type) {
		case 1:
			return {
				kind: 'frame',
				frame: { kind: 'h264', header, data: bytes.subarray(HEADER_LENGTH) }
			};
		case 2: {
			const tiles = readTiles(view, bytes);
			return typeof tiles === 'string'
				? bad(tiles)
				: { kind: 'frame', frame: { kind: 'tiles', header, tiles } };
		}
		case 3:
			if (bytes.byteLength < HEADER_LENGTH + 8) {
				return bad('a cursor shape is cut short');
			}
			return {
				kind: 'frame',
				frame: {
					kind: 'cursor-shape',
					header,
					id: view.getUint32(HEADER_LENGTH, true),
					hotspotX: view.getUint16(HEADER_LENGTH + 4, true),
					hotspotY: view.getUint16(HEADER_LENGTH + 6, true),
					png: bytes.subarray(HEADER_LENGTH + 8)
				}
			};
		case 4:
			if (bytes.byteLength < HEADER_LENGTH + 13) {
				return bad('a cursor position is cut short');
			}
			return {
				kind: 'frame',
				frame: {
					kind: 'cursor-position',
					header,
					id: view.getUint32(HEADER_LENGTH, true),
					x: view.getInt32(HEADER_LENGTH + 4, true),
					y: view.getInt32(HEADER_LENGTH + 8, true),
					visible: view.getUint8(HEADER_LENGTH + 12) !== 0
				}
			};
		default:
			return bad(`an unknown frame type ${header.type}`);
	}
}

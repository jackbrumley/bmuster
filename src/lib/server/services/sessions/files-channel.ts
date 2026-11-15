import type { z } from 'zod';
import type { CleanupItemId } from '#lib/domain/storage/cleanup.ts';
import type { FileErrorCode } from '#lib/domain/files/files.ts';
import { agentFilesReplySchema } from '#lib/schemas/files/files.ts';
import { sessionRelay, type Relay } from './relay.ts';
import type { EndedSession, LocalEnd } from './session-record.ts';

/**
 * The server's end of a files session (SPEC-FILES): one per person per
 * machine, opened by the first files request and ended after `idleMs` with
 * nothing running. Requests from any number of HTTP calls share it,
 * numbered so each reply finds its caller. Binary frames carry a 4-byte
 * request id, then the bytes.
 *
 * Files sent through a desktop session (SPEC-SESSION-FILES) use the same
 * channel with their own ops and error codes (`sessionFilesChannels`).
 */

export type AgentAnswer<Code extends string = FileErrorCode> =
	{ kind: 'done'; result: unknown } | { kind: 'error'; code: Code; message: string };

/** An agent's reply on a channel, as its schema parses it. */
type AgentReply<Code extends string> =
	| { type: 'done'; id: number; result: unknown }
	| { type: 'error'; id: number; code: Code; message: string };

/** What a kind of channel is: its reply schema, the code for a lost machine, and its idle message. */
export type ChannelKind<Code extends string> = {
	replies: z.ZodType<AgentReply<Code>>;
	ioCode: Code;
	idleMessage: string;
};

/** What the server asks the agent (agent/crates/protocol/src/files.rs `FilesOp`). */
export type FilesOp =
	| { op: 'roots' }
	| { op: 'list'; path: string }
	| { op: 'stat'; path: string }
	| { op: 'mkdir'; dir: string; name: string }
	| { op: 'rename'; dir: string; from: string; to: string }
	| { op: 'delete'; dir: string; names: string[]; recursive: boolean }
	| { op: 'write-begin'; dir: string; name: string; size: number; replace: boolean }
	| { op: 'write-end'; dir: string; name: string; size: number; sha256: string }
	| { op: 'write-cancel'; dir: string; name: string }
	// Storage (SPEC-STORAGE 5): the last scans, read on the same session.
	| { op: 'storage-summary' }
	| { op: 'storage-folder'; mount: string; path: string; offset: number }
	| { op: 'storage-largest'; mount: string; path: string }
	| { op: 'storage-rescan' }
	// Clean-up (SPEC-STORAGE 11): item ids only, never a path.
	| { op: 'storage-cleanup-sizes' }
	| { op: 'storage-cleanup-start'; runId: string; items: CleanupItemId[] }
	| { op: 'storage-cleanup-status' };

/** A read the caller is streaming: acknowledge what was passed on, or give up. */
export type ReadHandle<Code extends string = FileErrorCode> = {
	done: Promise<AgentAnswer<Code>>;
	ack(bytes: number): void;
	cancel(): void;
};

export type Channel<Op extends { op: string }, Code extends string> = {
	readonly sessionId: string;
	ask(request: Op, timeoutMs: number): Promise<AgentAnswer<Code>>;
	/** One upload chunk: its request (`op` included), then its data. */
	chunk(request: Op, data: Uint8Array, timeoutMs: number): Promise<AgentAnswer<Code>>;
	/** Streams what `request` reads to `onBytes`; quiet for `timeoutMs` means failed. */
	read(
		request: Op,
		onBytes: (data: Uint8Array) => void,
		timeoutMs: number
	): Promise<
		{ kind: 'reading'; handle: ReadHandle<Code> } | { kind: 'failed'; answer: AgentAnswer<Code> }
	>;
};

/** Every request on a files channel, chunks and reads included. */
type FilesChannelOp =
	| FilesOp
	| { op: 'write-chunk'; dir: string; name: string; offset: number }
	| { op: 'read'; path: string; offset: number; length: number };

export type FilesChannel = Channel<FilesChannelOp, FileErrorCode>;

/** How a new channel's session is asked for (the files service signs the ticket). */
export type OpenSession = (
	local: LocalEnd,
	onEnded: (ended: EndedSession) => void
) =>
	| { kind: 'opened'; sessionId: string }
	| { kind: 'refused'; status: 403 | 404 | 409 | 503; message: string };

export type ChannelLookup<C> =
	| { kind: 'channel'; channel: C }
	| { kind: 'refused'; status: 403 | 404 | 409 | 503; message: string };

type Pending<Code extends string> = {
	settle: (answer: AgentAnswer<Code>) => void;
	onBytes: ((data: Uint8Array) => void) | undefined;
	/** Restarts the reply timeout (a read that is still sending is alive). */
	touch: () => void;
};

export type Channels<Op extends { op: string }, Code extends string> = {
	/** The person's channel to the machine, asking for a session with `open` if there is none. */
	get(userId: string, machineId: string, open: OpenSession): ChannelLookup<Channel<Op, Code>>;
};

export type FilesChannels = Channels<FilesChannelOp, FileErrorCode>;

export function createFilesChannels(relay: Relay, limits: { idleMs: number }): FilesChannels {
	return createChannels(relay, limits, {
		replies: agentFilesReplySchema,
		ioCode: 'io',
		idleMessage: 'Files were not used for 5 minutes.'
	});
}

export function createChannels<Op extends { op: string }, Code extends string>(
	relay: Relay,
	limits: { idleMs: number },
	kind: ChannelKind<Code>
): Channels<Op, Code> {
	type Answer = AgentAnswer<Code>;
	const channels = new Map<string, Channel<Op, Code>>();

	function create(key: string, open: OpenSession): ChannelLookup<Channel<Op, Code>> {
		const pending = new Map<number, Pending<Code>>();
		let nextId = 1;
		let active = 0;
		let idleTimer: ReturnType<typeof setTimeout> | undefined;
		let endedMessage: string | undefined;
		let markReady: (ready: boolean) => void = () => undefined;
		const ready = new Promise<boolean>((resolve) => {
			markReady = resolve;
		});

		const local: LocalEnd = {
			ready: () => {
				markReady(true);
			},
			text: (text) => {
				const parsed = kind.replies.safeParse(parseJson(text));
				if (!parsed.success) {
					return;
				}
				const reply = parsed.data;
				pending
					.get(reply.id)
					?.settle(
						reply.type === 'done'
							? { kind: 'done', result: reply.result }
							: { kind: 'error', code: reply.code, message: reply.message }
					);
			},
			bytes: (data) => {
				if (data.byteLength < 4) {
					return;
				}
				const id = new DataView(data.buffer, data.byteOffset, 4).getUint32(0);
				const entry = pending.get(id);
				entry?.touch();
				entry?.onBytes?.(data.subarray(4));
			}
		};

		const opened = open(local, (ended) => {
			endedMessage = ended.message;
			if (channels.get(key) === channel) {
				channels.delete(key);
			}
			clearTimeout(idleTimer);
			markReady(false);
			for (const entry of [...pending.values()]) {
				entry.settle(gone());
			}
		});
		if (opened.kind === 'refused') {
			return opened;
		}
		const sessionId = opened.sessionId;

		function gone(): Answer {
			return {
				kind: 'error',
				code: kind.ioCode,
				message: endedMessage ?? 'The connection to the machine was lost.'
			};
		}

		function begin(): void {
			active += 1;
			clearTimeout(idleTimer);
		}

		function finish(): void {
			active -= 1;
			if (active === 0 && endedMessage === undefined) {
				idleTimer = setTimeout(() => {
					relay.end(sessionId, 'unused', kind.idleMessage);
				}, limits.idleMs);
				idleTimer.unref();
			}
		}

		/** Sends one request; `after` runs once it is sent (a chunk's data follows). */
		async function request(
			body: Op,
			timeoutMs: number,
			onBytes: ((data: Uint8Array) => void) | undefined,
			after: (id: number) => boolean
		): Promise<{ id: number; answer: Promise<Answer> } | { id: undefined; answer: Answer }> {
			if (!(await ready)) {
				return { id: undefined, answer: gone() };
			}
			const id = nextId;
			nextId = (nextId % 0xffff_fff0) + 1;
			const answer = new Promise<Answer>((resolve) => {
				let timer: ReturnType<typeof setTimeout> | undefined;
				const touch = (): void => {
					clearTimeout(timer);
					timer = setTimeout(() => {
						entry.settle({
							kind: 'error',
							code: kind.ioCode,
							message: 'The machine did not answer in time.'
						});
					}, timeoutMs);
					timer.unref();
				};
				const entry: Pending<Code> = {
					settle: (result) => {
						clearTimeout(timer);
						if (pending.delete(id)) {
							resolve(result);
						}
					},
					onBytes,
					touch
				};
				pending.set(id, entry);
				touch();
				const sent = relay.toAgent(sessionId, JSON.stringify({ id, ...body })) && after(id);
				if (!sent) {
					entry.settle(gone());
				}
			});
			return { id, answer };
		}

		const channel: Channel<Op, Code> = {
			sessionId,
			async ask(body, timeoutMs) {
				begin();
				try {
					const sent = await request(body, timeoutMs, undefined, () => true);
					return await sent.answer;
				} finally {
					finish();
				}
			},
			async chunk(body, data, timeoutMs) {
				begin();
				try {
					const sent = await request(body, timeoutMs, undefined, (id) =>
						relay.toAgent(sessionId, framed(id, data))
					);
					return await sent.answer;
				} finally {
					finish();
				}
			},
			async read(body, onBytes, timeoutMs) {
				begin();
				const sent = await request(body, timeoutMs, onBytes, () => true);
				if (sent.id === undefined) {
					finish();
					return { kind: 'failed', answer: sent.answer };
				}
				const id = sent.id;
				void sent.answer.then(finish);
				return {
					kind: 'reading',
					handle: {
						done: sent.answer,
						ack: (bytes) => {
							relay.toAgent(sessionId, JSON.stringify({ id, op: 'ack', bytes }));
						},
						cancel: () => {
							relay.toAgent(sessionId, JSON.stringify({ id, op: 'cancel' }));
						}
					}
				};
			}
		};
		channels.set(key, channel);
		return { kind: 'channel', channel };
	}

	return {
		get(userId, machineId, open) {
			const key = `${userId}/${machineId}`;
			const existing = channels.get(key);
			return existing === undefined ? create(key, open) : { kind: 'channel', channel: existing };
		}
	};
}

function framed(id: number, data: Uint8Array): Uint8Array {
	const frame = new Uint8Array(4 + data.byteLength);
	new DataView(frame.buffer).setUint32(0, id);
	frame.set(data, 4);
	return frame;
}

function parseJson(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

/** A files session with nothing running ends after this. */
const FILES_IDLE_MS = 5 * 60_000;

/** Kept on globalThis, like the relay: every copy of this module must share the channels. */
const CHANNELS_KEY = Symbol.for('bmuster.files-channels');

export function filesChannels(): FilesChannels {
	const existing: unknown = Reflect.get(globalThis, CHANNELS_KEY);
	if (isFilesChannels(existing)) {
		return existing;
	}
	const created = createFilesChannels(sessionRelay(), { idleMs: FILES_IDLE_MS });
	Reflect.set(globalThis, CHANNELS_KEY, created);
	return created;
}

function isFilesChannels(value: unknown): value is FilesChannels {
	return (
		typeof value === 'object' && value !== null && 'get' in value && typeof value.get === 'function'
	);
}

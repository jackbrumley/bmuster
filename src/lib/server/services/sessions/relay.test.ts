import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	CLOSE_ENDED,
	CLOSE_REPLACED,
	createRelay,
	RELAY_LIMITS,
	type EndedSession,
	type RelayPeer,
	type SessionRecord
} from './relay.ts';

/** A socket end that records what it was sent; bytes count as written when `flush` runs. */
type FakePeer = RelayPeer & {
	texts: unknown[];
	bytes: Buffer[];
	paused: boolean;
	closed: { code: number; reason: string } | undefined;
	unsent: (() => void)[];
	flush(): void;
};

function fakePeer(writeAtOnce: boolean): FakePeer {
	const peer: FakePeer = {
		texts: [],
		bytes: [],
		paused: false,
		closed: undefined,
		unsent: [],
		sendText(text) {
			peer.texts.push(JSON.parse(text));
		},
		sendBytes(data, sent) {
			peer.bytes.push(Buffer.from(data));
			if (writeAtOnce) {
				sent();
			} else {
				peer.unsent.push(sent);
			}
		},
		pause() {
			peer.paused = true;
		},
		resume() {
			peer.paused = false;
		},
		close(code, reason) {
			peer.closed = { code, reason };
		},
		flush() {
			for (const sent of peer.unsent.splice(0)) {
				sent();
			}
		}
	};
	return peer;
}

const RECORD: SessionRecord = {
	id: 'session-1',
	machineId: 'machine-1',
	userId: 'user-1',
	userName: 'Kim',
	kind: 'terminal',
	shell: 'bash',
	ip: '192.0.2.10',
	openedAt: 0
};

function started() {
	const relay = createRelay(RELAY_LIMITS);
	const ended: EndedSession[] = [];
	relay.start({ ...RECORD, openedAt: Date.now() }, (session) => ended.push(session));
	return { relay, ended };
}

function connectBrowser(relay: ReturnType<typeof createRelay>, peer: RelayPeer): void {
	const ticket = relay.issueBrowserTicket(RECORD.id, RECORD.userId);
	if (ticket === undefined) throw new Error('no ticket');
	expect(relay.redeemBrowserTicket(RECORD.id, ticket)).toBe(true);
	expect(relay.attachBrowser(RECORD.id, peer)).toEqual({ kind: 'attached' });
}

beforeEach(() => {
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
});

describe('the session relay (T4)', () => {
	it('passes bytes both ways untouched and forwards resizes', () => {
		const { relay } = started();
		const agent = fakePeer(true);
		const browser = fakePeer(true);
		connectBrowser(relay, browser);
		expect(relay.attachAgent(RECORD.id, RECORD.machineId, agent)).toEqual({ kind: 'attached' });
		expect(browser.texts).toEqual([{ type: 'attached', resumed: false }, { type: 'ready' }]);

		relay.fromBrowser(RECORD.id, browser, Buffer.from('ls\r'));
		relay.fromAgent(RECORD.id, agent, Buffer.from([0x1b, 0x5b, 0x41, 0xff]));
		relay.browserText(RECORD.id, browser, JSON.stringify({ type: 'resize', cols: 120, rows: 40 }));
		relay.browserText(RECORD.id, browser, '{"type":"rm -rf"}');

		expect(Buffer.concat(agent.bytes).toString()).toBe('ls\r');
		expect(Buffer.concat(browser.bytes)).toEqual(Buffer.from([0x1b, 0x5b, 0x41, 0xff]));
		expect(agent.texts).toEqual([{ type: 'resize', cols: 120, rows: 40 }]);
	});

	it('keeps what was typed before the agent connected and sends it once it does', () => {
		const { relay } = started();
		const browser = fakePeer(true);
		connectBrowser(relay, browser);
		relay.fromBrowser(RECORD.id, browser, Buffer.from('whoami\r'));
		const agent = fakePeer(true);
		relay.attachAgent(RECORD.id, RECORD.machineId, agent);
		expect(Buffer.concat(agent.bytes).toString()).toBe('whoami\r');
	});

	it('T10: keeps the latest resize sent before the agent connected and gives it to the agent first', () => {
		const { relay } = started();
		const browser = fakePeer(true);
		connectBrowser(relay, browser);
		relay.browserText(RECORD.id, browser, JSON.stringify({ type: 'resize', cols: 40, rows: 30 }));
		relay.browserText(RECORD.id, browser, JSON.stringify({ type: 'resize', cols: 96, rows: 20 }));
		relay.fromBrowser(RECORD.id, browser, Buffer.from('dir\r'));
		const agent = fakePeer(true);
		relay.attachAgent(RECORD.id, RECORD.machineId, agent);
		expect(agent.texts).toEqual([{ type: 'resize', cols: 96, rows: 20 }]);
		expect(Buffer.concat(agent.bytes).toString()).toBe('dir\r');

		relay.browserText(RECORD.id, browser, JSON.stringify({ type: 'resize', cols: 120, rows: 24 }));
		expect(agent.texts).toEqual([
			{ type: 'resize', cols: 96, rows: 20 },
			{ type: 'resize', cols: 120, rows: 24 }
		]);
	});

	it('T10: sends a late agent no resize when the browser never sent one (the open request has the size)', () => {
		const { relay } = started();
		connectBrowser(relay, fakePeer(true));
		const agent = fakePeer(true);
		relay.attachAgent(RECORD.id, RECORD.machineId, agent);
		expect(agent.texts).toEqual([]);
	});

	it('refuses an agent socket for another machine, and a second one for the same session', () => {
		const { relay } = started();
		expect(relay.attachAgent(RECORD.id, 'machine-2', fakePeer(true)).kind).toBe('refused');
		expect(relay.attachAgent(RECORD.id, RECORD.machineId, fakePeer(true)).kind).toBe('attached');
		expect(relay.attachAgent(RECORD.id, RECORD.machineId, fakePeer(true)).kind).toBe('refused');
	});

	it('pauses a fast agent while the browser is behind, and resumes it once the browser catches up', () => {
		const { relay } = started();
		const agent = fakePeer(true);
		const browser = fakePeer(false);
		connectBrowser(relay, browser);
		relay.attachAgent(RECORD.id, RECORD.machineId, agent);

		const chunk = Buffer.alloc(64 * 1024, 0x79);
		for (let sent = 0; sent <= RELAY_LIMITS.highWaterBytes; sent += chunk.byteLength) {
			expect(agent.paused).toBe(false);
			relay.fromAgent(RECORD.id, agent, chunk);
		}
		expect(agent.paused).toBe(true);
		browser.flush();
		expect(agent.paused).toBe(false);
	});

	it('pauses a fast browser (a huge paste) while the agent is behind', () => {
		const { relay } = started();
		const agent = fakePeer(false);
		const browser = fakePeer(true);
		connectBrowser(relay, browser);
		relay.attachAgent(RECORD.id, RECORD.machineId, agent);
		relay.fromBrowser(RECORD.id, browser, Buffer.alloc(RELAY_LIMITS.highWaterBytes + 1));
		expect(browser.paused).toBe(true);
		agent.flush();
		expect(browser.paused).toBe(false);
	});

	it('ignores bytes from a socket that is no longer the session’s', () => {
		const { relay } = started();
		const agent = fakePeer(true);
		const first = fakePeer(true);
		const second = fakePeer(true);
		connectBrowser(relay, first);
		relay.attachAgent(RECORD.id, RECORD.machineId, agent);
		connectBrowser(relay, second);
		expect(first.closed?.code).toBe(CLOSE_REPLACED);
		relay.fromBrowser(RECORD.id, first, Buffer.from('stale'));
		relay.browserClosed(RECORD.id, first);
		expect(agent.bytes).toEqual([]);
		relay.fromAgent(RECORD.id, agent, Buffer.from('fresh'));
		expect(Buffer.concat(second.bytes).toString()).toBe('fresh');
	});
});

describe('browser tickets (T4)', () => {
	it('work once, for the person who opened the session, within 30 seconds', () => {
		const { relay } = started();
		expect(relay.issueBrowserTicket(RECORD.id, 'someone-else')).toBeUndefined();
		const ticket = relay.issueBrowserTicket(RECORD.id, RECORD.userId) ?? '';
		expect(relay.redeemBrowserTicket('session-2', ticket)).toBe(false);
		const again = relay.issueBrowserTicket(RECORD.id, RECORD.userId) ?? '';
		expect(relay.redeemBrowserTicket(RECORD.id, again)).toBe(true);
		expect(relay.redeemBrowserTicket(RECORD.id, again)).toBe(false);
		const late = relay.issueBrowserTicket(RECORD.id, RECORD.userId) ?? '';
		vi.advanceTimersByTime(RELAY_LIMITS.browserTicketMs + 1);
		expect(relay.redeemBrowserTicket(RECORD.id, late)).toBe(false);
	});
});

describe('reloads (AGENTS.md §13)', () => {
	it('replays recent output to a browser that comes back', () => {
		const { relay } = started();
		const agent = fakePeer(true);
		const first = fakePeer(true);
		connectBrowser(relay, first);
		relay.attachAgent(RECORD.id, RECORD.machineId, agent);
		relay.fromAgent(RECORD.id, agent, Buffer.from('$ echo $((6*7))\r\n42\r\n'));
		relay.browserClosed(RECORD.id, first);
		vi.advanceTimersByTime(RELAY_LIMITS.noBrowserMs - 1000);

		const second = fakePeer(true);
		connectBrowser(relay, second);
		expect(second.texts).toEqual([{ type: 'attached', resumed: true }, { type: 'ready' }]);
		expect(Buffer.concat(second.bytes).toString()).toContain('42');
		vi.advanceTimersByTime(RELAY_LIMITS.noBrowserMs * 2);
		expect(relay.isRunning(RECORD.id)).toBe(true);
	});

	it('replays only the last 256 KB, from a line break', () => {
		const { relay } = started();
		const agent = fakePeer(true);
		relay.attachAgent(RECORD.id, RECORD.machineId, agent);
		const line = Buffer.from(`${'x'.repeat(99)}\n`);
		for (let index = 0; index < 5000; index += 1) {
			relay.fromAgent(RECORD.id, agent, line);
		}
		const browser = fakePeer(true);
		connectBrowser(relay, browser);
		const replay = Buffer.concat(browser.bytes);
		expect(replay.byteLength).toBeLessThanOrEqual(RELAY_LIMITS.replayBytes);
		expect(replay.byteLength).toBeGreaterThan(RELAY_LIMITS.replayBytes - 100);
		expect(replay.subarray(0, 100)).toEqual(line);
	});
});

describe('ending sessions (T6)', () => {
	it('ends when the person ends it, telling the browser and closing the agent', () => {
		const { relay, ended } = started();
		const agent = fakePeer(true);
		const browser = fakePeer(true);
		connectBrowser(relay, browser);
		relay.attachAgent(RECORD.id, RECORD.machineId, agent);
		relay.fromBrowser(RECORD.id, browser, Buffer.from('abc'));
		relay.fromAgent(RECORD.id, agent, Buffer.from('hello'));
		relay.browserText(RECORD.id, browser, '{"type":"end"}');
		expect(browser.texts.at(-1)).toMatchObject({ type: 'ended', reason: 'closed' });
		expect(browser.closed?.code).toBe(CLOSE_ENDED);
		expect(agent.closed?.code).toBe(1000);
		expect(ended).toMatchObject([{ reason: 'closed', bytesIn: 3, bytesOut: 5, userName: 'Kim' }]);
		expect(relay.isRunning(RECORD.id)).toBe(false);
		expect(relay.endedSession(RECORD.id)?.reason).toBe('closed');
	});

	it('ends when the shell exits, with its exit code', () => {
		const { relay, ended } = started();
		const agent = fakePeer(true);
		relay.attachAgent(RECORD.id, RECORD.machineId, agent);
		relay.agentText(RECORD.id, agent, '{"type":"exited","code":3}');
		expect(ended).toMatchObject([{ reason: 'exited', message: 'The shell exited with code 3.' }]);
	});

	it('ends when the agent fails, refuses, loses its socket or never connects', () => {
		const failed = started();
		const agent = fakePeer(true);
		failed.relay.attachAgent(RECORD.id, RECORD.machineId, agent);
		failed.relay.agentText(RECORD.id, agent, '{"type":"failed","message":"zsh is not installed"}');
		expect(failed.ended).toMatchObject([{ reason: 'failed', message: 'zsh is not installed' }]);

		const refused = started();
		refused.relay.refusedByAgent(RECORD.id, 'machine-2', 'not you');
		refused.relay.refusedByAgent(RECORD.id, RECORD.machineId, 'expired');
		expect(refused.ended).toMatchObject([{ reason: 'refused', message: 'expired' }]);

		const lost = started();
		const lostAgent = fakePeer(true);
		lost.relay.attachAgent(RECORD.id, RECORD.machineId, lostAgent);
		lost.relay.agentClosed(RECORD.id, lostAgent);
		expect(lost.ended).toMatchObject([{ reason: 'agent-lost' }]);

		const silent = started();
		vi.advanceTimersByTime(RELAY_LIMITS.agentWaitMs);
		expect(silent.ended).toMatchObject([{ reason: 'agent-timeout' }]);
	});

	it('ends 60 seconds after the last browser left', () => {
		const { relay, ended } = started();
		relay.attachAgent(RECORD.id, RECORD.machineId, fakePeer(true));
		const browser = fakePeer(true);
		connectBrowser(relay, browser);
		relay.browserClosed(RECORD.id, browser);
		vi.advanceTimersByTime(RELAY_LIMITS.noBrowserMs - 1);
		expect(ended).toEqual([]);
		vi.advanceTimersByTime(1);
		expect(ended).toMatchObject([{ reason: 'no-browser' }]);
	});

	it('ends after 60 minutes with no input, counting from the last keystroke', () => {
		const { relay, ended } = started();
		const agent = fakePeer(true);
		const browser = fakePeer(true);
		relay.attachAgent(RECORD.id, RECORD.machineId, agent);
		connectBrowser(relay, browser);
		vi.advanceTimersByTime(30 * 60_000);
		relay.fromBrowser(RECORD.id, browser, Buffer.from('x'));
		vi.advanceTimersByTime(59 * 60_000);
		expect(ended).toEqual([]);
		relay.fromAgent(RECORD.id, agent, Buffer.from('output is not input'));
		vi.advanceTimersByTime(60_000);
		expect(ended).toMatchObject([{ reason: 'idle' }]);
	});
});

describe('in use (T8)', () => {
	it('lists who is using a machine while their session runs', () => {
		const { relay } = started();
		expect(relay.inUse(RECORD.machineId)).toEqual([{ kind: 'terminal', userName: 'Kim' }]);
		expect(relay.inUse('machine-2')).toEqual([]);
		relay.end(RECORD.id, 'closed', 'done');
		expect(relay.inUse(RECORD.machineId)).toEqual([]);
	});
});

describe('local ends: the server in the browser’s place (SPEC-FILES)', () => {
	it('hands the agent’s replies and bytes to the server, takes no browser, and shows as in use', () => {
		const relay = createRelay(RELAY_LIMITS);
		const ended: EndedSession[] = [];
		const heard: { ready: number; texts: string[]; bytes: number[] } = {
			ready: 0,
			texts: [],
			bytes: []
		};
		const record: SessionRecord = { ...RECORD, kind: 'files', openedAt: Date.now() };
		relay.startLocal(record, (session) => ended.push(session), {
			ready: () => {
				heard.ready += 1;
			},
			text: (text) => heard.texts.push(text),
			bytes: (data) => heard.bytes.push(data.byteLength)
		});
		expect(relay.inUse(RECORD.machineId)).toEqual([{ kind: 'files', userName: 'Kim' }]);
		expect(relay.issueBrowserTicket(RECORD.id, RECORD.userId)).toBeUndefined();
		expect(relay.toAgent(RECORD.id, '{"id":1,"op":"roots"}')).toBe(false);

		const agent = fakePeer(true);
		expect(relay.attachAgent(RECORD.id, RECORD.machineId, agent)).toEqual({ kind: 'attached' });
		expect(heard.ready).toBe(1);
		expect(relay.toAgent(RECORD.id, '{"id":1,"op":"roots"}')).toBe(true);
		expect(relay.toAgent(RECORD.id, new Uint8Array(8))).toBe(true);
		expect(agent.texts).toEqual([{ id: 1, op: 'roots' }]);
		expect(agent.bytes).toHaveLength(1);

		relay.agentText(RECORD.id, agent, '{"type":"done","id":1,"result":{}}');
		relay.fromAgent(RECORD.id, agent, new Uint8Array(12));
		expect(heard.texts).toEqual(['{"type":"done","id":1,"result":{}}']);
		expect(heard.bytes).toEqual([12]);

		relay.agentText(RECORD.id, agent, '{"type":"failed","message":"no disk"}');
		expect(ended).toMatchObject([{ kind: 'files', reason: 'failed', bytesIn: 8, bytesOut: 12 }]);
		expect(relay.toAgent(RECORD.id, '{}')).toBe(false);
	});
});

describe('desktop sessions in the relay (SPEC-DESKTOP R2)', () => {
	function desktop() {
		const relay = createRelay(RELAY_LIMITS);
		const ended: EndedSession[] = [];
		relay.start({ ...RECORD, kind: 'desktop', mode: 'watch', openedAt: Date.now() }, (session) =>
			ended.push(session)
		);
		const agent = fakePeer(true);
		const browser = fakePeer(true);
		connectBrowser(relay, browser);
		relay.attachAgent(RECORD.id, RECORD.machineId, agent);
		return { relay, ended, agent, browser };
	}

	it('passes the JSON control messages both ways unread, and frames to the browser', () => {
		const { relay, agent, browser } = desktop();
		const hello = {
			type: 'hello',
			codecs: ['jpeg'],
			viewport: { width: 1, height: 1, pixelRatio: 1 }
		};
		relay.browserText(RECORD.id, browser, JSON.stringify(hello));
		relay.browserText(RECORD.id, browser, '{"type":"ack","seq":3}');
		relay.agentText(RECORD.id, agent, '{"type":"stalled"}');
		relay.fromAgent(RECORD.id, agent, Buffer.from([2, 0, 7, 1]));
		expect(agent.texts).toEqual([hello, { type: 'ack', seq: 3 }]);
		expect(browser.texts.slice(2)).toEqual([{ type: 'stalled' }]);
		expect(browser.bytes).toEqual([Buffer.from([2, 0, 7, 1])]);
		expect(relay.inUse(RECORD.machineId)).toEqual([
			{ kind: 'desktop', mode: 'watch', userName: 'Kim' }
		]);
	});

	it("ends with the agent's reason, and tells the browser in plain words", () => {
		const { relay, ended, agent, browser } = desktop();
		relay.agentText(RECORD.id, agent, '{"type":"ended","reason":"disconnected-at-machine"}');
		expect(ended.map((session) => session.reason)).toEqual(['disconnected-at-machine']);
		expect(browser.texts.at(-1)).toEqual({
			type: 'ended',
			reason: 'disconnected-at-machine',
			message: 'Someone at the machine pressed Disconnect.'
		});
		expect(agent.closed?.code).toBe(1000);
	});

	it('replays nothing to a reattaching browser: it asks for a keyframe instead', () => {
		const { relay, agent, browser } = desktop();
		relay.fromAgent(RECORD.id, agent, Buffer.alloc(1000, 2));
		relay.browserClosed(RECORD.id, browser);
		const again = fakePeer(true);
		connectBrowser(relay, again);
		expect(again.bytes).toEqual([]);
		expect(again.texts).toEqual([{ type: 'attached', resumed: true }, { type: 'ready' }]);
	});

	it('the console can still end it with end', () => {
		const { relay, ended, browser } = desktop();
		relay.browserText(RECORD.id, browser, '{"type":"end"}');
		expect(ended.map((session) => session.reason)).toEqual(['closed']);
	});
});

describe('desktop agent hand-over (SPEC-DESKTOP R13, Windows helper)', () => {
	function desktop() {
		const relay = createRelay(RELAY_LIMITS);
		const ended: EndedSession[] = [];
		relay.start({ ...RECORD, kind: 'desktop', mode: 'control', openedAt: Date.now() }, (session) =>
			ended.push(session)
		);
		const agent = fakePeer(true);
		const browser = fakePeer(true);
		connectBrowser(relay, browser);
		relay.attachAgent(RECORD.id, RECORD.machineId, agent);
		browser.texts.length = 0;
		return { relay, ended, agent, browser };
	}

	it('a new agent socket takes the session over: the old one is closed and the browser greets the new one', () => {
		const { relay, ended, agent, browser } = desktop();
		const moved = fakePeer(true);
		expect(relay.attachAgent(RECORD.id, RECORD.machineId, moved)).toEqual({ kind: 'attached' });
		expect(agent.closed?.code).toBe(CLOSE_REPLACED);
		expect(browser.texts).toEqual([{ type: 'ready' }]);
		// The old helper's last words and frames no longer count.
		relay.agentText(RECORD.id, agent, '{"type":"ended","reason":"agent-lost"}');
		relay.fromAgent(RECORD.id, agent, Buffer.from([9]));
		relay.agentClosed(RECORD.id, agent);
		expect(ended).toEqual([]);
		expect(browser.bytes).toEqual([]);
		relay.browserText(RECORD.id, browser, '{"type":"keyframe"}');
		expect(moved.texts).toEqual([{ type: 'keyframe' }]);
		expect(agent.texts).toEqual([]);
	});

	it('waits for a lost agent socket to come back before ending the session', () => {
		const { relay, ended, agent, browser } = desktop();
		relay.agentClosed(RECORD.id, agent);
		vi.advanceTimersByTime(RELAY_LIMITS.agentHandoverMs - 1);
		expect(ended).toEqual([]);
		const back = fakePeer(true);
		expect(relay.attachAgent(RECORD.id, RECORD.machineId, back)).toEqual({ kind: 'attached' });
		expect(browser.texts).toEqual([{ type: 'ready' }]);
		vi.advanceTimersByTime(RELAY_LIMITS.agentWaitMs);
		expect(ended).toEqual([]);

		relay.agentClosed(RECORD.id, back);
		vi.advanceTimersByTime(RELAY_LIMITS.agentHandoverMs);
		expect(ended).toMatchObject([{ reason: 'agent-lost' }]);
	});

	it('another machine cannot take a desktop session over', () => {
		const { relay, agent } = desktop();
		expect(relay.attachAgent(RECORD.id, 'machine-2', fakePeer(true))).toMatchObject({
			kind: 'refused'
		});
		expect(agent.closed).toBeUndefined();
	});
});

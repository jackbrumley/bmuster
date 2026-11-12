import type { MachineStatusEvent } from '#lib/domain/machines/machine-events.ts';

/**
 * Stands in for the browser's EventSource (stub it with
 * `vi.stubGlobal('EventSource', FakeEventSource)`), so a test can push
 * status events to a page (SPEC-PRESENCE P5).
 */
export class FakeEventSource extends EventTarget {
	static readonly CLOSED = 2;
	static opened: FakeEventSource[] = [];
	readyState = 1;
	readonly url: string;

	constructor(url: string) {
		super();
		this.url = url;
		FakeEventSource.opened.push(this);
	}

	close(): void {
		this.readyState = FakeEventSource.CLOSED;
	}

	push(event: MachineStatusEvent): void {
		this.dispatchEvent(new MessageEvent('status', { data: JSON.stringify(event) }));
	}

	/** What the browser does when the server refuses the stream. */
	refuse(): void {
		this.readyState = FakeEventSource.CLOSED;
		this.dispatchEvent(new Event('error'));
	}
}

/** The newest feed the page opened. */
export function feed(): FakeEventSource {
	const source = FakeEventSource.opened.at(-1);
	if (source === undefined) throw new Error('The page opened no live feed');
	return source;
}

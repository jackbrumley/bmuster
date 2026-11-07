/**
 * A browser WebSocket the page tests drive (stub it with
 * `vi.stubGlobal('WebSocket', FakeSocket)`): what the page sends, and
 * messages from the "server".
 */
export class FakeSocket {
	static readonly OPEN = 1;
	static last: FakeSocket | undefined;
	readonly url: string;
	readyState = 1;
	binaryType = 'blob';
	readonly sent: (string | Uint8Array)[] = [];
	readonly #listeners = new Map<string, ((event: unknown) => void)[]>();

	constructor(url: string) {
		this.url = url;
		FakeSocket.last = this;
	}

	addEventListener(type: string, listener: (event: unknown) => void): void {
		this.#listeners.set(type, [...(this.#listeners.get(type) ?? []), listener]);
	}

	send(data: string | Uint8Array): void {
		this.sent.push(data);
	}

	close(): void {
		this.readyState = 3;
	}

	/** The connection drops without the server closing it (code 1006). */
	drop(): void {
		this.readyState = 3;
		for (const listener of this.#listeners.get('close') ?? []) {
			listener({ code: 1006 });
		}
	}

	receive(data: string | Uint8Array): void {
		const payload = typeof data === 'string' ? data : data.slice().buffer;
		for (const listener of this.#listeners.get('message') ?? []) {
			listener({ data: payload });
		}
	}

	/** Bytes the page sent, as text. */
	typed(): string[] {
		return this.sent
			.filter((item): item is Uint8Array => typeof item !== 'string')
			.map((bytes) => new TextDecoder().decode(bytes));
	}

	/** Text frames the page sent, parsed. */
	messages(): unknown[] {
		return this.sent
			.filter((item): item is string => typeof item === 'string')
			.map((text): unknown => JSON.parse(text));
	}
}

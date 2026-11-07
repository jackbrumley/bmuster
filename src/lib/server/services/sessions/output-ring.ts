/**
 * The last part of a session's output, replayed to a browser that
 * reattaches (after a reload). Kept as the chunks that arrived; the oldest
 * are dropped once the total passes the limit, and the replay starts after a
 * line break where it can, so it does not begin halfway through a line.
 */
export class OutputRing {
	readonly #limit: number;
	#chunks: Uint8Array[] = [];
	#size = 0;
	#dropped = false;

	constructor(limit: number) {
		this.#limit = limit;
	}

	push(data: Uint8Array): void {
		if (data.byteLength === 0) {
			return;
		}
		this.#chunks.push(data);
		this.#size += data.byteLength;
		while (this.#size > this.#limit) {
			const oldest = this.#chunks[0];
			if (oldest === undefined) {
				break;
			}
			this.#dropped = true;
			const excess = this.#size - this.#limit;
			if (oldest.byteLength <= excess) {
				this.#chunks.shift();
				this.#size -= oldest.byteLength;
			} else {
				this.#chunks[0] = oldest.subarray(excess);
				this.#size -= excess;
			}
		}
	}

	/** Everything kept, from the first line break once anything was dropped. */
	contents(): Uint8Array {
		const all = Buffer.concat(this.#chunks);
		if (!this.#dropped) {
			return all;
		}
		const lineBreak = all.indexOf(0x0a);
		return lineBreak >= 0 && lineBreak < all.byteLength - 1 ? all.subarray(lineBreak + 1) : all;
	}
}

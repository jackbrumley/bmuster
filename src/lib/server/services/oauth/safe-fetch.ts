import { lookup } from 'node:dns/promises';
import { request } from 'node:https';
import { BlockList, isIPv4, isIPv6 } from 'node:net';

/**
 * Fetching a client's metadata document (SPEC-MCP M6, 11.3 "SSRF through a CIMD URL"). The URL
 * comes from whoever starts an authorisation request, so it is untrusted: HTTPS only, public
 * addresses only (every address the name resolves to is checked, and the connection goes to the
 * checked address, so a second lookup cannot swap in a private one), no redirects, 5 seconds and
 * 64 KB at most.
 */

export const FETCH_LIMITS = { timeoutMs: 5000, maxBytes: 64 * 1024 } as const;

export type FetchedJson = { kind: 'ok'; json: unknown } | { kind: 'failed'; reason: string };

/** How the authorisation server fetches a document; tests pass their own. */
export type FetchJson = (url: string) => Promise<FetchedJson>;

const NOT_PUBLIC = new BlockList();
for (const [network, prefix] of [
	['0.0.0.0', 8],
	['10.0.0.0', 8],
	['100.64.0.0', 10],
	['127.0.0.0', 8],
	['169.254.0.0', 16],
	['172.16.0.0', 12],
	['192.0.0.0', 24],
	['192.0.2.0', 24],
	['192.88.99.0', 24],
	['192.168.0.0', 16],
	['198.18.0.0', 15],
	['198.51.100.0', 24],
	['203.0.113.0', 24],
	['224.0.0.0', 4],
	['240.0.0.0', 4]
] as const) {
	NOT_PUBLIC.addSubnet(network, prefix, 'ipv4');
}
for (const [network, prefix] of [
	['::', 128],
	['::1', 128],
	['64:ff9b::', 96],
	['64:ff9b:1::', 48],
	['100::', 64],
	['2001::', 23],
	['2001:db8::', 32],
	['2002::', 16],
	['fc00::', 7],
	['fe80::', 10],
	['fec0::', 10],
	['ff00::', 8]
] as const) {
	NOT_PUBLIC.addSubnet(network, prefix, 'ipv6');
}

const MAPPED_V4 = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i;

/** True only for an address on the public internet. */
export function isPublicAddress(address: string): boolean {
	const mapped = MAPPED_V4.exec(address)?.[1];
	if (mapped !== undefined) {
		return isPublicAddress(mapped);
	}
	if (isIPv4(address)) {
		return !NOT_PUBLIC.check(address, 'ipv4');
	}
	if (isIPv6(address)) {
		// IPv4-mapped addresses in hex form (::ffff:7f00:1) are not public either.
		return !address.toLowerCase().startsWith('::ffff:') && !NOT_PUBLIC.check(address, 'ipv6');
	}
	return false;
}

/** The URL if it may be fetched at all: HTTPS, default port or another, no credentials. */
export function fetchableUrl(raw: string): URL | undefined {
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		return undefined;
	}
	if (url.protocol !== 'https:' || url.username !== '' || url.password !== '') {
		return undefined;
	}
	return url;
}

/** Resolves the host and refuses it unless every address is public. */
async function publicAddressOf(hostname: string): Promise<string | undefined> {
	const bare = hostname.startsWith('[') ? hostname.slice(1, -1) : hostname;
	if (isIPv4(bare) || isIPv6(bare)) {
		return isPublicAddress(bare) ? bare : undefined;
	}
	const addresses = await lookup(bare, { all: true, order: 'verbatim' }).catch(() => []);
	if (addresses.length === 0 || !addresses.every((entry) => isPublicAddress(entry.address))) {
		return undefined;
	}
	return addresses[0]?.address;
}

/** GET a JSON document under the limits above. Never throws. */
export async function safeFetchJson(raw: string): Promise<FetchedJson> {
	const url = fetchableUrl(raw);
	if (url === undefined) {
		return { kind: 'failed', reason: 'The address must start with https://.' };
	}
	const address = await publicAddressOf(url.hostname);
	if (address === undefined) {
		return { kind: 'failed', reason: 'The address is not on the public internet.' };
	}
	const servername = url.hostname.startsWith('[') ? '' : url.hostname;
	return new Promise((resolve) => {
		const outgoing = request(
			{
				host: address,
				servername,
				port: url.port === '' ? 443 : Number(url.port),
				path: `${url.pathname}${url.search}`,
				method: 'GET',
				headers: { host: url.host, accept: 'application/json' },
				timeout: FETCH_LIMITS.timeoutMs
			},
			(response) => {
				if (response.statusCode !== 200) {
					response.destroy();
					resolve({
						kind: 'failed',
						reason: `It answered ${String(response.statusCode)}; redirects are not followed.`
					});
					return;
				}
				const chunks: Buffer[] = [];
				let size = 0;
				response.on('data', (chunk: Buffer) => {
					size += chunk.length;
					if (size > FETCH_LIMITS.maxBytes) {
						response.destroy();
						resolve({ kind: 'failed', reason: 'The document is larger than 64 KB.' });
						return;
					}
					chunks.push(chunk);
				});
				response.on('end', () => {
					try {
						resolve({ kind: 'ok', json: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
					} catch {
						resolve({ kind: 'failed', reason: 'The document is not JSON.' });
					}
				});
				response.on('error', () => {
					resolve({ kind: 'failed', reason: 'The connection broke.' });
				});
			}
		);
		const deadline = setTimeout(() => {
			outgoing.destroy();
			resolve({ kind: 'failed', reason: 'It took longer than 5 seconds.' });
		}, FETCH_LIMITS.timeoutMs);
		outgoing.on('close', () => {
			clearTimeout(deadline);
		});
		outgoing.on('timeout', () => {
			outgoing.destroy();
			resolve({ kind: 'failed', reason: 'It took longer than 5 seconds.' });
		});
		outgoing.on('error', () => {
			resolve({ kind: 'failed', reason: 'It could not be reached.' });
		});
		outgoing.end();
	});
}

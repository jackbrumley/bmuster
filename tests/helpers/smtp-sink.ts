import { createServer, type Server, type Socket } from 'node:net';

/**
 * A tiny SMTP server for tests: it accepts every message on 127.0.0.1 and
 * keeps it in memory, so no test ever sends real email. It speaks enough
 * SMTP for upyo (EHLO, AUTH PLAIN and LOGIN, MAIL, RCPT, DATA, QUIT), offers
 * no STARTTLS, and can refuse recipients to test failures.
 */
type SunkMessage = {
	from: string;
	to: string[];
	/** The raw message as received, headers and body. */
	raw: string;
	/** The username and password the client signed in with, if it did. */
	auth: { kind: 'none' } | { kind: 'signed-in'; username: string; password: string };
};

export type SmtpSink = {
	port: number;
	messages: SunkMessage[];
	/** While true, every recipient is refused with 550. */
	refuseRecipients: boolean;
	close(): Promise<void>;
};

type Session = {
	from: string;
	to: string[];
	data: string[] | undefined;
	auth: SunkMessage['auth'];
	login: { step: 'none' } | { step: 'username' } | { step: 'password'; username: string };
};

function decode(base64: string): string {
	return Buffer.from(base64, 'base64').toString('utf8');
}

export async function startSmtpSink(): Promise<SmtpSink> {
	const sockets = new Set<Socket>();
	const sink: SmtpSink = {
		port: 0,
		messages: [],
		refuseRecipients: false,
		close: () => Promise.resolve()
	};
	const server: Server = createServer((socket) => {
		sockets.add(socket);
		socket.on('close', () => sockets.delete(socket));
		socket.on('error', () => sockets.delete(socket));
		const session: Session = {
			from: '',
			to: [],
			data: undefined,
			auth: { kind: 'none' },
			login: { step: 'none' }
		};
		const reply = (line: string): void => {
			socket.write(`${line}\r\n`);
		};
		reply('220 bmuster-test-sink ESMTP');
		let buffered = '';
		socket.on('data', (chunk) => {
			buffered += chunk.toString('utf8');
			let end = buffered.indexOf('\r\n');
			while (end >= 0) {
				const line = buffered.slice(0, end);
				buffered = buffered.slice(end + 2);
				handle(line);
				end = buffered.indexOf('\r\n');
			}
		});
		function handle(line: string): void {
			if (session.data !== undefined) {
				if (line === '.') {
					sink.messages.push({
						from: session.from,
						to: session.to,
						raw: session.data.join('\r\n'),
						auth: session.auth
					});
					session.data = undefined;
					session.to = [];
					reply(`250 2.0.0 Ok: queued as SINK${sink.messages.length}`);
					return;
				}
				session.data.push(line.startsWith('..') ? line.slice(1) : line);
				return;
			}
			if (session.login.step === 'username') {
				session.login = { step: 'password', username: decode(line) };
				reply('334 UGFzc3dvcmQ6');
				return;
			}
			if (session.login.step === 'password') {
				session.auth = {
					kind: 'signed-in',
					username: session.login.username,
					password: decode(line)
				};
				session.login = { step: 'none' };
				reply('235 2.7.0 Authentication successful');
				return;
			}
			const verb = line.split(' ')[0]?.toUpperCase() ?? '';
			switch (verb) {
				case 'EHLO':
					socket.write('250-bmuster-test-sink\r\n250-AUTH PLAIN LOGIN\r\n250 8BITMIME\r\n');
					return;
				case 'HELO':
				case 'NOOP':
				case 'RSET':
					reply('250 Ok');
					return;
				case 'AUTH': {
					const [, method, initial] = line.split(' ');
					if (method?.toUpperCase() === 'PLAIN' && initial !== undefined) {
						const [, username = '', password = ''] = decode(initial).split('\u0000');
						session.auth = { kind: 'signed-in', username, password };
						reply('235 2.7.0 Authentication successful');
					} else if (method?.toUpperCase() === 'LOGIN') {
						session.login = { step: 'username' };
						reply('334 VXNlcm5hbWU6');
					} else {
						reply('504 Unrecognised authentication type');
					}
					return;
				}
				case 'MAIL':
					session.from = line.slice(line.indexOf(':') + 1).trim();
					reply('250 Ok');
					return;
				case 'RCPT':
					if (sink.refuseRecipients) {
						reply('550 5.1.1 Recipient refused by the test sink');
						return;
					}
					session.to.push(line.slice(line.indexOf(':') + 1).trim());
					reply('250 Ok');
					return;
				case 'DATA':
					session.data = [];
					reply('354 End data with <CR><LF>.<CR><LF>');
					return;
				case 'QUIT':
					reply('221 Bye');
					socket.end();
					return;
				default:
					reply('502 Command not implemented');
			}
		}
	});
	await new Promise<void>((resolve) => {
		server.listen(0, '127.0.0.1', resolve);
	});
	const address = server.address();
	if (address === null || typeof address === 'string') {
		throw new Error('The SMTP sink has no port');
	}
	sink.port = address.port;
	sink.close = () =>
		new Promise<void>((resolve) => {
			for (const socket of sockets) {
				socket.destroy();
			}
			server.close(() => {
				resolve();
			});
		});
	return sink;
}

/** The text of a message with quoted-printable soft breaks and escapes undone, for finding links. */
export function readableBody(raw: string): string {
	return raw
		.replace(/=\r\n/g, '')
		.replace(/=([0-9A-F]{2})/g, (_match, hex: string) =>
			String.fromCharCode(Number.parseInt(hex, 16))
		);
}

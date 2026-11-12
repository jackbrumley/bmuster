/**
 * The small part of Markdown that GitHub release notes use (SPEC-SERVER-UPDATES
 * SU15): headings, bullet lists, paragraphs, and inline bold, code and links.
 * Parsed into data and drawn by components, never as HTML, so a release body
 * cannot put markup in the console. Links are kept only for https addresses.
 */

export type Inline =
	| { kind: 'text'; text: string }
	| { kind: 'bold'; text: string }
	| { kind: 'code'; text: string }
	| { kind: 'link'; text: string; href: string };

export type Block =
	| { kind: 'heading'; level: 2 | 3; content: Inline[] }
	| { kind: 'list'; items: Inline[][] }
	| { kind: 'paragraph'; content: Inline[] };

const INLINE =
	/\*\*([^*]+)\*\*|`([^`]+)`|\[([^\]]+)\]\((https:\/\/[^)\s]+)\)|(https:\/\/[^\s<>()]+)/g;

/** Splits one line of text into plain, bold, code and link runs. */
export function parseInline(line: string): Inline[] {
	const runs: Inline[] = [];
	let at = 0;
	for (const match of line.matchAll(INLINE)) {
		const start = match.index;
		if (start > at) runs.push({ kind: 'text', text: line.slice(at, start) });
		const [whole, bold, code, linkText, linkHref, bare] = match;
		if (bold !== undefined) runs.push({ kind: 'bold', text: bold });
		else if (code !== undefined) runs.push({ kind: 'code', text: code });
		else if (linkText !== undefined && linkHref !== undefined)
			runs.push({ kind: 'link', text: linkText, href: linkHref });
		else if (bare !== undefined) runs.push({ kind: 'link', text: bare, href: bare });
		at = start + whole.length;
	}
	if (at < line.length) runs.push({ kind: 'text', text: line.slice(at) });
	return runs;
}

/** Turns a release body into blocks; anything unknown reads as a paragraph. */
export function parseReleaseMarkdown(body: string): Block[] {
	const blocks: Block[] = [];
	let list: Inline[][] | undefined;
	let paragraph: string[] = [];
	const flushParagraph = (): void => {
		if (paragraph.length > 0) {
			blocks.push({ kind: 'paragraph', content: parseInline(paragraph.join(' ')) });
			paragraph = [];
		}
	};
	const flushList = (): void => {
		if (list !== undefined) {
			blocks.push({ kind: 'list', items: list });
			list = undefined;
		}
	};
	for (const raw of body.replaceAll('\r\n', '\n').split('\n')) {
		const line = raw.trim();
		const heading = /^(#{1,6})\s+(.*)$/.exec(line);
		const item = /^[-*+]\s+(.*)$/.exec(line);
		if (line === '') {
			flushParagraph();
			flushList();
		} else if (heading !== null) {
			flushParagraph();
			flushList();
			const level = (heading[1] ?? '').length <= 2 ? 2 : 3;
			blocks.push({ kind: 'heading', level, content: parseInline(heading[2] ?? '') });
		} else if (item !== null) {
			flushParagraph();
			list ??= [];
			list.push(parseInline(item[1] ?? ''));
		} else {
			flushList();
			paragraph.push(line);
		}
	}
	flushParagraph();
	flushList();
	return blocks;
}

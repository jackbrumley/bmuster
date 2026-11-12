import { describe, expect, it } from 'vitest';
import { parseInline, parseReleaseMarkdown } from './release-markdown.ts';

describe('release notes Markdown (SPEC-SERVER-UPDATES SU15)', () => {
	it('SU15: reads headings, bullet lists and paragraphs from a GitHub release body', () => {
		const body = [
			'## What changed',
			'',
			'- Taps: tap twice to double click',
			'- Fixed cursor: no crosshair',
			'',
			'## What to test on real machines',
			'',
			'* Phone: try the three taps',
			'',
			'**Full Changelog**: https://github.com/jackbrumley/bmuster/compare/v0.4.22...v0.4.23'
		].join('\r\n');
		expect(parseReleaseMarkdown(body)).toEqual([
			{ kind: 'heading', level: 2, content: [{ kind: 'text', text: 'What changed' }] },
			{
				kind: 'list',
				items: [
					[{ kind: 'text', text: 'Taps: tap twice to double click' }],
					[{ kind: 'text', text: 'Fixed cursor: no crosshair' }]
				]
			},
			{
				kind: 'heading',
				level: 2,
				content: [{ kind: 'text', text: 'What to test on real machines' }]
			},
			{ kind: 'list', items: [[{ kind: 'text', text: 'Phone: try the three taps' }]] },
			{
				kind: 'paragraph',
				content: [
					{ kind: 'bold', text: 'Full Changelog' },
					{ kind: 'text', text: ': ' },
					{
						kind: 'link',
						text: 'https://github.com/jackbrumley/bmuster/compare/v0.4.22...v0.4.23',
						href: 'https://github.com/jackbrumley/bmuster/compare/v0.4.22...v0.4.23'
					}
				]
			}
		]);
	});

	it('SU15: keeps links only for https and never reads markup', () => {
		expect(parseInline('see [docs](https://example.com/a) and `npm run x`')).toEqual([
			{ kind: 'text', text: 'see ' },
			{ kind: 'link', text: 'docs', href: 'https://example.com/a' },
			{ kind: 'text', text: ' and ' },
			{ kind: 'code', text: 'npm run x' }
		]);
		expect(parseInline('[bad](javascript:alert(1)) <b>x</b>')).toEqual([
			{ kind: 'text', text: '[bad](javascript:alert(1)) <b>x</b>' }
		]);
	});
});

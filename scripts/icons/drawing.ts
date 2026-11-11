/**
 * The text and pixel transforms `npm run icons:generate` applies to the one
 * source drawing, docs/logo.svg (SPEC-BRAND-ICON). Pure, so the unit tests
 * can check every committed icon still matches the drawing.
 */
export const SOURCE = 'docs/logo.svg';

type Attributes = Readonly<Record<string, string>>;

function elementPattern(id: string): RegExp {
	return id === 'sweep'
		? /<g id="sweep"[^>]*>[\s\S]*?<\/g>/
		: new RegExp(`<[a-z]+ id="${id}"[^>]*/>`);
}

function find(svg: string, id: string): string {
	const match = elementPattern(id).exec(svg);
	if (match === null) throw new Error(`${SOURCE} has no element with id "${id}"`);
	return match[0];
}

function setAttributes(element: string, attributes: Attributes): string {
	let next = element;
	for (const [name, value] of Object.entries(attributes)) {
		const pattern = new RegExp(`\\s${name}="[^"]*"`);
		if (!pattern.test(next)) throw new Error(`${SOURCE}: no ${name} on ${element}`);
		next = next.replace(pattern, ` ${name}="${value}"`);
	}
	return next;
}

export function withoutComments(svg: string): string {
	return svg.replace(/\s*<!--[\s\S]*?-->/g, '');
}

/** iOS wants an opaque square and rounds its corners itself, so its icon is the disc's colour filling the square. */
export function fullBleed(svg: string): string {
	const face = find(svg, 'face');
	const fill = /fill="([^"]+)"/.exec(face);
	if (fill === null) throw new Error(`${SOURCE}: the face has no fill`);
	const backdrop = `<rect id="backdrop" x="26" y="26" width="204" height="204" fill="${fill[1] ?? ''}"/>`;
	return svg.replace(face, `${backdrop}\n\t${setAttributes(face, { 'stroke-width': '0' })}`);
}

function sized(svg: string, size: number): string {
	return svg.replace(/^<svg [^>]*>/, (root) =>
		setAttributes(root, { width: String(size), height: String(size) })
	);
}

/** For drawing inside a page beside the wordmark: decorative, so no title. */
function decorative(svg: string, size: number): string {
	return sized(svg, size)
		.replace(/\s*<title>[^<]*<\/title>/, '')
		.replace(/^<svg /, '<svg aria-hidden="true" ');
}

export function dataUri(svg: string): string {
	return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
}

/** StatusNotifierItem's pixmap format: ARGB32, network byte order. */
export function argb(rgba: Buffer): Buffer {
	const out = Buffer.alloc(rgba.length);
	for (let i = 0; i < rgba.length; i += 4) {
		out[i] = rgba[i + 3] ?? 0;
		out[i + 1] = rgba[i] ?? 0;
		out[i + 2] = rgba[i + 1] ?? 0;
		out[i + 3] = rgba[i + 2] ?? 0;
	}
	return out;
}

/**
 * Every generated SVG file and its contents, from the source drawing's text.
 * The error page is not here: it carries the full mark as a data URI.
 */
export function svgFiles(sourceText: string): readonly (readonly [string, string])[] {
	const source = withoutComments(sourceText);
	return [
		['static/brand/bmuster-logo.svg', source],
		['static/favicon.svg', sized(source, 32)],
		['docs/favicon.svg', sized(source, 32)],
		['agent/crates/agent/assets/logo-small.svg', decorative(source, 32)],
		// The Linux applications-menu and autostart icon (hicolor scalable).
		['agent/crates/agent/assets/bmuster.svg', source],
		// The Linux tray icon by name (hicolor scalable), drawn sharp at any panel size.
		['agent/crates/agent/assets/bmuster-tray.svg', sized(source, 22)]
	];
}

/** The error page's logo, the full mark at 48px. */
export function errorPageLogo(sourceText: string): string {
	return dataUri(sized(withoutComments(sourceText), 48));
}

/** Pixel icons: file, which drawing, edge in pixels. */
export const PNG_ICONS = [
	{ file: 'static/brand/icon-192.png', drawing: 'full', size: 192 },
	{ file: 'static/brand/icon-512.png', drawing: 'full', size: 512 },
	{ file: 'static/apple-touch-icon.png', drawing: 'full-bleed', size: 180 }
] as const;

/** The agent's tray icons (raw ARGB), the same drawing as every other icon. */
export const TRAY_SIZES = [22, 32, 48] as const;

export function trayFile(size: number): string {
	return `agent/crates/agent/assets/tray-${String(size)}.argb`;
}

import type { Report } from './report.ts';
import type { SourceFile } from './source-file.ts';
import { allDeclarations } from './template.ts';

/**
 * Corner radius by role (AGENTS.md §4): things you click are pills, things
 * you type into are boxes, cards, modals, dots and avatars have their own
 * role. Every `border-radius` (and per-corner longhand) in a component
 * `<style>` block, `style="…"` attribute, `style:border-radius` directive or
 * src/app.css is `var(--radius-<role>)` for a role declared in
 * src/lib/ui/design-tokens.css, or 0.
 *
 * Later: radius values written inside script strings, once any code builds
 * styles in TypeScript.
 */
const BORDER_RADIUS_RULE = 'border-radius-token-required';

/** The stylesheet that declares the `--radius-*` variables. */
export const RADIUS_VARIABLES_FILE = 'src/lib/ui/design-tokens.css';

/** The roles a stylesheet declares as `--radius-<role>` custom properties. */
export function radiusRoles(tokens: SourceFile | undefined): ReadonlySet<string> {
	const roles = new Set<string>();
	if (tokens === undefined) return roles;
	for (const declaration of allDeclarations(tokens)) {
		const role = /^--radius-([a-z]+)$/.exec(declaration.property.trim())?.[1];
		if (role !== undefined) roles.add(role);
	}
	return roles;
}

/** A CSS radius value: only `var(--radius-<known role>)` and `0`, space or `/` separated. */
function isCssRadiusValue(value: string, roles: ReadonlySet<string>): boolean {
	const parts = value
		.trim()
		.split(/\s+|\s*\/\s*/)
		.filter((part) => part !== '');
	return (
		parts.length > 0 &&
		parts.every((part) => {
			if (part === '0') return true;
			const role = /^var\(--radius-([a-z]+)\)$/.exec(part)?.[1];
			return role !== undefined && roles.has(role);
		})
	);
}

/** Whether a CSS property sets a corner radius. */
function isCssRadiusProperty(property: string): boolean {
	return /^border(-[a-z]+)*-radius$/.test(property.trim().toLowerCase());
}

export function verifyBorderRadius(
	files: readonly SourceFile[],
	roles: ReadonlySet<string>,
	report: Report
): void {
	for (const file of files) {
		if (!file.isCss && !file.isSvelte) continue;
		for (const declaration of allDeclarations(file)) {
			if (!isCssRadiusProperty(declaration.property)) continue;
			if (!declaration.dynamic && isCssRadiusValue(declaration.value, roles)) continue;
			report(
				BORDER_RADIUS_RULE,
				file.relPath,
				`Line ${declaration.line}: ${declaration.property}: ${
					declaration.dynamic ? '{…}' : declaration.value.trim()
				}; use var(--radius-<role>) (${[...roles].join(', ')}) or 0`
			);
		}
	}
}

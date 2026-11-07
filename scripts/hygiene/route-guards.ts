import ts from 'typescript';
import type { Report } from './report.ts';
import { resolveLocalImport } from './server-boundary.ts';
import { isTestFile } from './source-file.ts';

/**
 * Route guards (AGENTS.md §11, SPEC-SIGN-IN S7): every route handler checks
 * access before it runs.
 *
 * - Every HTTP method a `+server.ts` exports is built by a guard:
 *   `export const GET = route.<public|user|admin|agent>(…)`.
 * - Every `load` and form action in `+page.server.ts` / `+layout.server.ts`
 *   is built by `page.<public|user|admin>(…)`; `actions` is an object of
 *   guarded handlers.
 * - Universal `+page.ts` / `+layout.ts` files may not export `load`: it would
 *   run without a guard. Use the matching `.server.ts` file.
 *
 * `route` and `page` must be imported from src/lib/server/guards/.
 */
const ROUTE_GUARD_RULE = 'route-guard-required';

const HTTP_METHODS: ReadonlySet<string> = new Set([
	'GET',
	'POST',
	'PUT',
	'PATCH',
	'DELETE',
	'OPTIONS',
	'HEAD',
	'fallback'
]);
const GUARDS = {
	route: new Set(['public', 'user', 'admin', 'agent']),
	page: new Set(['public', 'user', 'admin'])
} as const;
type GuardObject = keyof typeof GUARDS;

const GUARDS_DIR = 'src/lib/server/guards/';

type RouteFileKind = 'endpoint' | 'server-load' | 'universal-load';

function routeFileKind(relPath: string): RouteFileKind | null {
	if (!relPath.startsWith('src/routes/') || isTestFile(relPath)) return null;
	const name = relPath.slice(relPath.lastIndexOf('/') + 1);
	if (/^\+server\.(ts|js)$/.test(name)) return 'endpoint';
	if (/^\+(page|layout)(@[\w-]*)?\.server\.(ts|js)$/.test(name)) return 'server-load';
	if (/^\+(page|layout)(@[\w-]*)?\.(ts|js)$/.test(name)) return 'universal-load';
	return null;
}

/** Local names bound to `route` / `page` imported from the guards folder. */
function guardBindings(relPath: string, source: ts.SourceFile): Map<string, GuardObject> {
	const bindings = new Map<string, GuardObject>();
	for (const statement of source.statements) {
		if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) {
			continue;
		}
		const resolved = resolveLocalImport(relPath, statement.moduleSpecifier.text);
		if (resolved?.startsWith(GUARDS_DIR) !== true) continue;
		const named = statement.importClause?.namedBindings;
		if (named === undefined || !ts.isNamedImports(named)) continue;
		for (const element of named.elements) {
			const imported = (element.propertyName ?? element.name).text;
			if (imported === 'route' || imported === 'page') bindings.set(element.name.text, imported);
		}
	}
	return bindings;
}

/** `route.admin(…)`: the guard object and variant, or null when the expression is not a guard call. */
function guardCall(
	node: ts.Expression,
	bindings: Map<string, GuardObject>
): { object: GuardObject; variant: string } | null {
	let expression = node;
	while (
		ts.isParenthesizedExpression(expression) ||
		ts.isSatisfiesExpression(expression) ||
		ts.isAsExpression(expression)
	) {
		expression = expression.expression;
	}
	if (!ts.isCallExpression(expression)) return null;
	const callee = expression.expression;
	if (!ts.isPropertyAccessExpression(callee) || !ts.isIdentifier(callee.expression)) return null;
	const object = bindings.get(callee.expression.text);
	return object === undefined ? null : { object, variant: callee.name.text };
}

type Export = { name: string; initializer: ts.Expression | null; node: ts.Node };

function exportsOf(statement: ts.Statement): Export[] {
	const exported =
		ts.canHaveModifiers(statement) &&
		(ts.getModifiers(statement) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
	if (ts.isVariableStatement(statement) && exported) {
		return statement.declarationList.declarations
			.filter((d) => ts.isIdentifier(d.name))
			.map((d) => ({ name: d.name.getText(), initializer: d.initializer ?? null, node: d }));
	}
	if (ts.isFunctionDeclaration(statement) && exported && statement.name !== undefined) {
		return [{ name: statement.name.text, initializer: null, node: statement }];
	}
	if (
		ts.isExportDeclaration(statement) &&
		statement.exportClause !== undefined &&
		ts.isNamedExports(statement.exportClause)
	) {
		return statement.exportClause.elements.map((e) => ({
			name: e.name.text,
			initializer: null,
			node: e
		}));
	}
	return [];
}

/** The handlers a route file exports, each with the guard object it must use. */
function guardedSlots(
	kind: RouteFileKind,
	source: ts.SourceFile
): {
	name: string;
	initializer: ts.Expression | null;
	node: ts.Node;
	guard: GuardObject | 'none';
}[] {
	const slots: ReturnType<typeof guardedSlots> = [];
	for (const statement of source.statements) {
		for (const item of exportsOf(statement)) {
			if (kind === 'endpoint' && HTTP_METHODS.has(item.name)) {
				slots.push({ ...item, guard: 'route' });
			} else if (kind === 'server-load' && item.name === 'load') {
				slots.push({ ...item, guard: 'page' });
			} else if (kind === 'server-load' && item.name === 'actions') {
				let object = item.initializer;
				while (
					object !== null &&
					(ts.isSatisfiesExpression(object) ||
						ts.isAsExpression(object) ||
						ts.isParenthesizedExpression(object))
				) {
					object = object.expression;
				}
				if (object !== null && ts.isObjectLiteralExpression(object)) {
					for (const property of object.properties) {
						slots.push({
							name: `actions.${property.name?.getText(source) ?? '…'}`,
							initializer: ts.isPropertyAssignment(property) ? property.initializer : null,
							node: property,
							guard: 'page'
						});
					}
				} else {
					slots.push({ ...item, guard: 'page' });
				}
			} else if (kind === 'universal-load' && item.name === 'load') {
				slots.push({ ...item, guard: 'none' });
			}
		}
	}
	return slots;
}

/** The problems in one route file; empty when every handler is guarded. */
export function scanRouteGuards(relPath: string, text: string): string[] {
	const kind = routeFileKind(relPath);
	if (kind === null) return [];
	const source = ts.createSourceFile(relPath, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
	const lineOf = (node: ts.Node): number =>
		source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
	const bindings = guardBindings(relPath, source);
	const issues: string[] = [];
	for (const slot of guardedSlots(kind, source)) {
		if (slot.guard === 'none') {
			issues.push(
				`line ${lineOf(slot.node)}: a universal \`load\` runs without a guard; move it to the matching .server.ts file as \`export const load = page.<access>(…)\`.`
			);
			continue;
		}
		const variants = [...GUARDS[slot.guard]].map((v) => `${slot.guard}.${v}`).join(' / ');
		const call = slot.initializer === null ? null : guardCall(slot.initializer, bindings);
		if (call?.object !== slot.guard) {
			issues.push(
				`line ${lineOf(slot.node)}: \`${slot.name}\` must be built by a guard (${variants} from src/lib/server/guards/), so access is checked before it runs.`
			);
		} else if (!GUARDS[slot.guard].has(call.variant)) {
			issues.push(
				`line ${lineOf(slot.node)}: \`${slot.guard}.${call.variant}\` is not a guard; use ${variants}.`
			);
		}
	}
	return issues;
}

export function checkRouteGuards(relPath: string, text: string, report: Report): void {
	for (const issue of scanRouteGuards(relPath, text)) report(ROUTE_GUARD_RULE, relPath, issue);
}

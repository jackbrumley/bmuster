import ts from 'typescript';

/** One module a file imports or re-exports. */
export interface ModuleImport {
	readonly specifier: string;
	/** `import type …`, or only `type` specifiers: erased at runtime. */
	readonly typeOnly: boolean;
	/** Character offset of the import in the scanned text. */
	readonly position: number;
}

function isTypeOnlyImport(node: ts.ImportDeclaration): boolean {
	const clause = node.importClause;
	if (!clause) return false; // `import 'x'` runs the module.
	if (clause.phaseModifier === ts.SyntaxKind.TypeKeyword) return true;
	if (clause.name) return false;
	const bindings = clause.namedBindings;
	if (!bindings || ts.isNamespaceImport(bindings)) return false;
	return bindings.elements.length > 0 && bindings.elements.every((element) => element.isTypeOnly);
}

function isTypeOnlyExport(node: ts.ExportDeclaration): boolean {
	if (node.isTypeOnly) return true;
	const clause = node.exportClause;
	return (
		!!clause &&
		ts.isNamedExports(clause) &&
		clause.elements.length > 0 &&
		clause.elements.every((element) => element.isTypeOnly)
	);
}

/** Static imports, re-exports and literal dynamic `import()` calls in TypeScript/JavaScript text. */
export function findImports(fileName: string, text: string): ModuleImport[] {
	const source = ts.createSourceFile(
		fileName,
		text,
		ts.ScriptTarget.Latest,
		true,
		/\.[jt]sx$/.test(fileName) ? ts.ScriptKind.TSX : ts.ScriptKind.TS
	);
	const imports: ModuleImport[] = [];
	const visit = (node: ts.Node): void => {
		if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
			imports.push({
				specifier: node.moduleSpecifier.text,
				typeOnly: isTypeOnlyImport(node),
				position: node.getStart(source)
			});
		} else if (
			ts.isExportDeclaration(node) &&
			node.moduleSpecifier &&
			ts.isStringLiteral(node.moduleSpecifier)
		) {
			imports.push({
				specifier: node.moduleSpecifier.text,
				typeOnly: isTypeOnlyExport(node),
				position: node.getStart(source)
			});
		} else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
			const argument = node.arguments[0];
			if (argument && ts.isStringLiteralLike(argument)) {
				imports.push({
					specifier: argument.text,
					typeOnly: false,
					position: node.getStart(source)
				});
			}
		} else if (ts.isImportTypeNode(node)) {
			const literal = node.argument;
			if (ts.isLiteralTypeNode(literal) && ts.isStringLiteral(literal.literal)) {
				imports.push({
					specifier: literal.literal.text,
					typeOnly: true,
					position: node.getStart(source)
				});
			}
		}
		ts.forEachChild(node, visit);
	};
	visit(source);
	return imports;
}

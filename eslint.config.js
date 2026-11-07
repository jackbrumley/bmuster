import prettier from 'eslint-config-prettier';
import path from 'node:path';
import js from '@eslint/js';
import svelte from 'eslint-plugin-svelte';
import { defineConfig, includeIgnoreFile } from 'eslint/config';
import globals from 'globals';
import ts from 'typescript-eslint';

const gitignorePath = path.resolve(import.meta.dirname, '.gitignore');

export default defineConfig(
	includeIgnoreFile(gitignorePath),
	{
		// Drizzle migrations are generated, not written.
		ignores: ['src/lib/server/database/migrations/**', 'static/**']
	},
	js.configs.recommended,
	ts.configs.strictTypeChecked,
	ts.configs.stylisticTypeChecked,
	svelte.configs.recommended,
	prettier,
	svelte.configs.prettier,
	{
		languageOptions: {
			globals: { ...globals.browser, ...globals.node },
			parserOptions: {
				projectService: true,
				extraFileExtensions: ['.svelte'],
				tsconfigRootDir: import.meta.dirname
			}
		},
		linterOptions: {
			// Lint bypass comments are not allowed at all (AGENTS.md).
			noInlineConfig: true,
			reportUnusedDisableDirectives: 'error'
		},
		rules: {
			// typescript-eslint recommend leaving no-undef off for TypeScript.
			'no-undef': 'off',
			'@typescript-eslint/no-explicit-any': 'error',
			'@typescript-eslint/no-unused-vars': [
				'error',
				{ argsIgnorePattern: '^_', varsIgnorePattern: '^_', ignoreRestSiblings: true }
			],
			'@typescript-eslint/ban-ts-comment': [
				'error',
				{ 'ts-expect-error': true, 'ts-ignore': true, 'ts-nocheck': true, 'ts-check': false }
			],
			'@typescript-eslint/consistent-type-imports': 'error',
			'@typescript-eslint/consistent-type-definitions': 'off',
			// App.Locals and friends are interfaces in SvelteKit's App namespace.
			'@typescript-eslint/no-empty-object-type': [
				'error',
				{ allowInterfaces: 'with-single-extends' }
			],
			'@typescript-eslint/no-extraneous-class': ['error', { allowStaticOnly: true }],
			'@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
			// Conditions say exactly what they test: no truthiness checks.
			'@typescript-eslint/strict-boolean-expressions': 'error',
			// Discriminated unions are handled case by case.
			'@typescript-eslint/switch-exhaustiveness-check': 'error',
			// `{...} as T` hides missing fields; build typed values instead.
			'@typescript-eslint/consistent-type-assertions': [
				'error',
				{ assertionStyle: 'as', objectLiteralTypeAssertions: 'never' }
			],
			eqeqeq: ['error', 'always'],
			'no-console': 'error',
			'svelte/block-lang': ['error', { script: 'ts' }],
			'svelte/button-has-type': 'error',
			'svelte/no-target-blank': 'error',
			'svelte/no-dom-manipulating': 'error',
			'svelte/require-each-key': 'error',
			'svelte/no-at-html-tags': 'error'
		}
	},
	{
		files: ['**/*.svelte', '**/*.svelte.ts'],
		languageOptions: { parserOptions: { parser: ts.parser } }
	},
	{
		// Command-line scripts report to the terminal (AGENTS.md §7).
		files: ['scripts/**'],
		rules: { 'no-console': 'off' }
	},
	{
		files: ['**/*.js'],
		...ts.configs.disableTypeChecked
	}
);

import type { Rule } from "eslint";
import type ts from "typescript";
import { analyzeSourceFile, type ThrowsDiagnostic } from "@mirek/throwscript-core";

export interface RuleOptions {
  /** Ignore `@throws` documented in `.d.ts` files (lib, `@types/*`). */
  ignoreExternal?: boolean;
}

export const OPTIONS_SCHEMA = [
  {
    type: "object",
    properties: {
      ignoreExternal: { type: "boolean" },
    },
    additionalProperties: false,
  },
];

export const DOCS_URL =
  "https://github.com/mirek/throwscript/tree/main/packages/eslint-plugin#rules";

/** The subset of typescript-eslint's parser services this plugin relies on. */
interface TypedParserServices {
  program?: ts.Program | null;
  esTreeNodeToTSNodeMap?: { get(node: unknown): ts.Node | undefined };
}

/**
 * Both rules run the analyzer over the same file during the same lint pass;
 * the result is computed once per source file and option set. Keyed on the
 * `ts.SourceFile` object so a re-parsed file (project service, watch mode)
 * gets fresh diagnostics and stale programs can be garbage collected.
 */
const cache = new WeakMap<ts.SourceFile, Map<string, ThrowsDiagnostic[]>>();

/**
 * Diagnostics for the file being linted, of every kind; each rule picks the
 * kind it reports.
 */
export function getDiagnostics(
  context: Rule.RuleContext,
  ruleName: string,
  options: RuleOptions,
): ThrowsDiagnostic[] {
  const services = context.sourceCode.parserServices as TypedParserServices | undefined;
  const program = services?.program;
  if (program === undefined || program === null) {
    throw new Error(
      `throwscript/${ruleName} requires type information. Parse with ` +
        "@typescript-eslint/parser and set parserOptions.projectService (or " +
        "parserOptions.project) — see https://typescript-eslint.io/getting-started/typed-linting",
    );
  }
  const sourceFile =
    (services?.esTreeNodeToTSNodeMap?.get(context.sourceCode.ast) as ts.SourceFile | undefined) ??
    program.getSourceFile(context.filename);
  if (sourceFile === undefined) return [];

  const key = String(options.ignoreExternal === true);
  let byOptions = cache.get(sourceFile);
  if (byOptions === undefined) {
    byOptions = new Map();
    cache.set(sourceFile, byOptions);
  }
  let diagnostics = byOptions.get(key);
  if (diagnostics === undefined) {
    diagnostics = [];
    analyzeSourceFile(
      sourceFile,
      program.getTypeChecker(),
      { reportUnused: true, ignoreExternal: options.ignoreExternal === true },
      diagnostics,
    );
    byOptions.set(key, diagnostics);
  }
  return diagnostics;
}

/**
 * Convert the analyzer's 1-based line/column into an ESLint location that
 * spans the token at that position (the function name, `function` keyword,
 * or `@throws` tag), or a point when the position is inside a comment.
 */
export function locationOf(
  context: Rule.RuleContext,
  diagnostic: ThrowsDiagnostic,
  fallbackLength: number,
): { start: { line: number; column: number }; end: { line: number; column: number } } {
  const start = { line: diagnostic.line, column: diagnostic.column - 1 };
  const index = context.sourceCode.getIndexFromLoc(start);
  const token = context.sourceCode.getTokenByRangeStart(index);
  if (token !== null) return { start, end: token.loc.end };
  return { start, end: { line: start.line, column: start.column + fallbackLength } };
}

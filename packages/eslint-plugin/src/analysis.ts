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
 * the result is computed once per program, source file, and option set. Keyed
 * on the `ts.Program` first: a rebuilt program (project service, watch mode)
 * can reuse an unchanged file's `ts.SourceFile` object even though a callee's
 * `@throws` contract changed, so diagnostics cached against an old program
 * must never be served. Old programs and re-parsed files are garbage
 * collected together with their cache entries.
 */
const cache = new WeakMap<
  ts.Program,
  WeakMap<ts.SourceFile, Map<string, ThrowsDiagnostic[]>>
>();

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
  let byFile = cache.get(program);
  if (byFile === undefined) {
    byFile = new WeakMap();
    cache.set(program, byFile);
  }
  let byOptions = byFile.get(sourceFile);
  if (byOptions === undefined) {
    byOptions = new Map();
    byFile.set(sourceFile, byOptions);
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

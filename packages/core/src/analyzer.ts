import ts from "typescript";

export type DiagnosticKind = "missing-throws" | "unused-throws";
export type Severity = "error" | "warning";

/** A text edit that resolves a diagnostic: replace [start, end) with `text`. */
export interface ThrowsFix {
  start: number;
  end: number;
  text: string;
}

export interface ThrowsDiagnostic {
  kind: DiagnosticKind;
  severity: Severity;
  file: string;
  line: number;
  column: number;
  functionName: string;
  /** Error type names involved (missing or unused, depending on kind). */
  types: string[];
  message: string;
  /** Present when the diagnostic can be auto-fixed (see `applyFixes`). */
  fix?: ThrowsFix;
}

export interface AnalyzeOptions {
  /**
   * Report documented @throws types that the checker cannot see being thrown.
   * Defaults to true (reported as warnings).
   */
  reportUnused?: boolean;
}

/** A thrown error type observed while walking a function body. */
interface ThrownType {
  name: string;
  /** Resolved type, when available, used for assignability against documented types. */
  type: ts.Type | undefined;
  node: ts.Node;
}

interface DocumentedType {
  name: string;
  type: ts.Type | undefined;
  tag: ts.JSDocTag;
}

const FALLBACK_ERROR_NAME = "Error";

/**
 * Analyze a program and return diagnostics for every function-like that can
 * throw (or reject, for Promise-returning functions) but does not declare the
 * error type in a JSDoc `@throws` tag.
 */
export function analyzeProgram(
  program: ts.Program,
  options: AnalyzeOptions = {},
): ThrowsDiagnostic[] {
  const checker = program.getTypeChecker();
  const diagnostics: ThrowsDiagnostic[] = [];

  for (const sourceFile of program.getSourceFiles()) {
    if (sourceFile.isDeclarationFile) continue;
    if (program.isSourceFileFromExternalLibrary(sourceFile)) continue;
    analyzeSourceFile(sourceFile, checker, options, diagnostics);
  }
  return diagnostics;
}

export function analyzeSourceFile(
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
  options: AnalyzeOptions,
  diagnostics: ThrowsDiagnostic[],
): void {
  const mutedLines = collectMutedLines(sourceFile);
  const visit = (node: ts.Node): void => {
    if (isCheckableFunction(node)) {
      checkFunction(node, sourceFile, checker, options, diagnostics, mutedLines);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
}

const MUTE_DIRECTIVE = /@nothrow(-next-line|-line)?\b/g;

/**
 * Collect 0-based line numbers muted by `@nothrow` directives in comments,
 * mirroring eslint's disable comments:
 *
 * - `// @nothrow` or `// @nothrow-line` mutes the line the directive is on
 *   (use it trailing a `throw`, a call, a declaration, or a `@throws` tag)
 * - `// @nothrow-next-line` mutes the following line
 *
 * Both forms also work inside block comments; inside a multi-line comment the
 * directive applies relative to the line it is written on.
 */
export function collectMutedLines(sourceFile: ts.SourceFile): Set<number> {
  const muted = new Set<number>();
  const scanner = ts.createScanner(
    ts.ScriptTarget.Latest,
    /* skipTrivia */ false,
    ts.LanguageVariant.Standard,
    sourceFile.text,
  );
  let token = scanner.scan();
  while (token !== ts.SyntaxKind.EndOfFileToken) {
    if (
      token === ts.SyntaxKind.SingleLineCommentTrivia ||
      token === ts.SyntaxKind.MultiLineCommentTrivia
    ) {
      const commentStart = scanner.getTokenStart();
      const commentText = scanner.getTokenText();
      for (const match of commentText.matchAll(MUTE_DIRECTIVE)) {
        const directiveLine = sourceFile.getLineAndCharacterOfPosition(
          commentStart + match.index,
        ).line;
        muted.add(match[1] === "-next-line" ? directiveLine + 1 : directiveLine);
      }
    }
    token = scanner.scan();
  }
  return muted;
}

function isCheckableFunction(node: ts.Node): node is ts.FunctionLikeDeclaration {
  return (
    (ts.isFunctionDeclaration(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isConstructorDeclaration(node) ||
      ts.isGetAccessorDeclaration(node) ||
      ts.isSetAccessorDeclaration(node) ||
      ts.isFunctionExpression(node) ||
      ts.isArrowFunction(node)) &&
    node.body !== undefined
  );
}

function checkFunction(
  fn: ts.FunctionLikeDeclaration,
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
  options: AnalyzeOptions,
  diagnostics: ThrowsDiagnostic[],
  mutedLines: Set<number>,
): void {
  // A muted throw site (throw statement, propagating call, Promise.reject)
  // does not count as an observable throw at all.
  const thrown = collectThrownTypes(fn, checker).filter(
    (t) =>
      !mutedLines.has(
        sourceFile.getLineAndCharacterOfPosition(t.node.getStart(sourceFile)).line,
      ),
  );
  const documented = getDocumentedThrows(fn, checker);

  const missing = thrown.filter(
    (t) => !documented.some((d) => covers(d, t, checker)),
  );
  // Collapse duplicates by name, keep first occurrence for location.
  const missingByName = new Map<string, ThrownType>();
  for (const t of missing) {
    if (!missingByName.has(t.name)) missingByName.set(t.name, t);
  }

  const name = functionDisplayName(fn);

  if (missingByName.size > 0) {
    const anchor = fn.name ?? fn;
    const pos = sourceFile.getLineAndCharacterOfPosition(anchor.getStart(sourceFile));
    if (!mutedLines.has(pos.line)) {
      const types = [...missingByName.keys()];
      diagnostics.push({
        kind: "missing-throws",
        severity: "error",
        file: sourceFile.fileName,
        line: pos.line + 1,
        column: pos.character + 1,
        functionName: name,
        types,
        message:
          `${name} can throw ${formatTypeList(types)} but has no @throws tag for ` +
          `${types.length === 1 ? "it" : "them"}. ` +
          `Document with ${types.map((t) => `\`@throws {${t}}\``).join(", ")}.`,
        fix: computeMissingThrowsFix(fn, sourceFile, types),
      });
    }
  }

  if (options.reportUnused !== false) {
    const unused = documented.filter(
      (d) => !thrown.some((t) => covers(d, t, checker)),
    );
    for (const d of unused) {
      const pos = sourceFile.getLineAndCharacterOfPosition(d.tag.getStart(sourceFile));
      if (mutedLines.has(pos.line)) continue;
      diagnostics.push({
        kind: "unused-throws",
        severity: "warning",
        file: sourceFile.fileName,
        line: pos.line + 1,
        column: pos.character + 1,
        functionName: name,
        types: [d.name],
        message: `${name} documents @throws {${d.name}} but nothing observable throws it.`,
      });
    }
  }
}

/**
 * Compute the text edit that documents the missing types: append `@throws`
 * lines to the function's existing JSDoc block, or create a new block above
 * the declaration. Returns undefined when no safe insertion point exists
 * (e.g. an inline callback that does not start its line).
 */
function computeMissingThrowsFix(
  fn: ts.FunctionLikeDeclaration,
  sourceFile: ts.SourceFile,
  types: string[],
): ThrowsFix | undefined {
  const anchor = fixAnchor(fn);
  const text = sourceFile.text;

  const anchorStart = anchor.getStart(sourceFile);
  const anchorLine = sourceFile.getLineAndCharacterOfPosition(anchorStart).line;
  const lineStart = sourceFile.getPositionOfLineAndCharacter(anchorLine, 0);
  // Only fix when the declaration starts its own line — inserting a JSDoc
  // block mid-expression would attach it to the wrong node.
  if (text.slice(lineStart, anchorStart).trim() !== "") return undefined;
  const indent = text.slice(lineStart, anchorStart);

  const jsdoc = findLeadingJSDocRange(sourceFile, anchor);
  if (jsdoc === undefined) {
    const block =
      `${indent}/**\n` +
      types.map((t) => `${indent} * @throws {${t}}\n`).join("") +
      `${indent} */\n`;
    return { start: lineStart, end: lineStart, text: block };
  }

  const closeStart = jsdoc.end - 2; // position of the closing `*/`
  const openLine = sourceFile.getLineAndCharacterOfPosition(jsdoc.pos).line;
  const closeLine = sourceFile.getLineAndCharacterOfPosition(closeStart).line;
  if (closeLine > openLine) {
    // Multi-line JSDoc: insert the tags above the closing line.
    const closeLineStart = sourceFile.getPositionOfLineAndCharacter(closeLine, 0);
    const lines = types.map((t) => `${indent} * @throws {${t}}\n`).join("");
    return { start: closeLineStart, end: closeLineStart, text: lines };
  }
  // Single-line JSDoc (`/** desc */`): break it open before the `*/`.
  const lines =
    `\n` +
    types.map((t) => `${indent} * @throws {${t}}`).join("\n") +
    `\n${indent} `;
  return { start: closeStart, end: closeStart, text: lines };
}

/** The node a JSDoc comment for `fn` attaches to (e.g. the variable statement for an arrow). */
function fixAnchor(fn: ts.FunctionLikeDeclaration): ts.Node {
  if (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) {
    const parent = fn.parent;
    if (
      ts.isVariableDeclaration(parent) &&
      ts.isVariableDeclarationList(parent.parent) &&
      ts.isVariableStatement(parent.parent.parent)
    ) {
      return parent.parent.parent;
    }
    if (ts.isPropertyAssignment(parent) || ts.isPropertyDeclaration(parent)) {
      return parent;
    }
  }
  return fn;
}

/** The range of the JSDoc block immediately preceding `node`, if any. */
function findLeadingJSDocRange(
  sourceFile: ts.SourceFile,
  node: ts.Node,
): ts.CommentRange | undefined {
  const ranges = ts.getLeadingCommentRanges(sourceFile.text, node.pos) ?? [];
  for (let i = ranges.length - 1; i >= 0; i--) {
    const range = ranges[i];
    if (
      range !== undefined &&
      range.kind === ts.SyntaxKind.MultiLineCommentTrivia &&
      sourceFile.text.startsWith("/**", range.pos)
    ) {
      return range;
    }
  }
  return undefined;
}

/**
 * Whether a documented @throws type covers a thrown type: exact name match, or
 * the documented type appears in the thrown type's heritage chain (e.g.
 * `@throws {Error}` covers a thrown `ValidationError extends Error`).
 *
 * Deliberately nominal rather than structural: `class A extends Error {}` and
 * `class B extends Error {}` are structurally identical, so TypeScript
 * assignability would let a documented A "cover" a thrown B.
 */
function covers(doc: DocumentedType, thrown: ThrownType, checker: ts.TypeChecker): boolean {
  if (doc.name === thrown.name) return true;
  if (thrown.type === undefined) return false;
  return heritageNames(thrown.type, checker).has(doc.name);
}

/** Collect the names of every base class/interface in a type's extends chain. */
function heritageNames(
  type: ts.Type,
  checker: ts.TypeChecker,
  seen: Set<string> = new Set(),
): Set<string> {
  if (!(type.isClassOrInterface() || (type.flags & ts.TypeFlags.Object) !== 0)) {
    return seen;
  }
  let bases: ts.Type[];
  try {
    bases = checker.getBaseTypes(type as ts.InterfaceType) ?? [];
  } catch {
    return seen;
  }
  for (const base of bases) {
    const name = (base.getSymbol() ?? base.aliasSymbol)?.getName();
    if (name === undefined || seen.has(name)) continue;
    seen.add(name);
    heritageNames(base, checker, seen);
  }
  return seen;
}

function getDocumentedThrows(
  fn: ts.FunctionLikeDeclaration,
  checker: ts.TypeChecker,
): DocumentedType[] {
  const result: DocumentedType[] = [];
  for (const tag of ts.getJSDocTags(fn)) {
    const tagName = tag.tagName.text;
    if (tagName !== "throws" && tagName !== "exception") continue;
    const typeExpression = ts.isJSDocThrowsTag(tag) ? tag.typeExpression : undefined;
    if (typeExpression === undefined) {
      // `@throws description` with no {Type}: treat as documenting the base Error.
      result.push({ name: FALLBACK_ERROR_NAME, type: undefined, tag });
      continue;
    }
    for (const typeNode of splitUnionTypeNode(typeExpression.type)) {
      let type: ts.Type | undefined;
      try {
        type = checker.getTypeFromTypeNode(typeNode);
        if (type.flags & ts.TypeFlags.Any) type = undefined;
      } catch {
        type = undefined;
      }
      result.push({ name: typeNode.getText(), type, tag });
    }
  }
  return result;
}

function splitUnionTypeNode(node: ts.TypeNode): ts.TypeNode[] {
  if (ts.isUnionTypeNode(node)) return node.types.flatMap(splitUnionTypeNode);
  if (ts.isParenthesizedTypeNode(node)) return splitUnionTypeNode(node.type);
  return [node];
}

/**
 * Walk a function body and collect every error type that can escape it:
 * direct `throw` statements, `@throws`-documented callees, rethrown caught
 * errors, and Promise rejections (`Promise.reject`, awaited/returned promises
 * from `@throws`-documented async callees).
 */
function collectThrownTypes(
  fn: ts.FunctionLikeDeclaration,
  checker: ts.TypeChecker,
): ThrownType[] {
  const collected: ThrownType[] = [];
  const body = fn.body;
  if (body === undefined) return collected;
  visitForThrows(body, checker, (t) => collected.push(t));
  return collected;
}

function visitForThrows(
  node: ts.Node,
  checker: ts.TypeChecker,
  report: (t: ThrownType) => void,
  catchContext?: { variableName: string | undefined; caughtTypes: ThrownType[] },
): void {
  // Nested functions own their throws; they are checked independently.
  if (ts.isFunctionLike(node)) return;

  if (ts.isTryStatement(node)) {
    visitTryStatement(node, checker, report, catchContext);
    return;
  }

  if (ts.isThrowStatement(node)) {
    reportThrowStatement(node, checker, report, catchContext);
    // Still walk the thrown expression: `throw makeError()` may call a
    // @throws-documented factory that itself can throw something else.
    visitForThrows(node.expression, checker, report, catchContext);
    return;
  }

  if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
    reportCallExpression(node, checker, report);
    ts.forEachChild(node, (child) =>
      visitForThrows(child, checker, report, catchContext),
    );
    return;
  }

  ts.forEachChild(node, (child) => visitForThrows(child, checker, report, catchContext));
}

function visitTryStatement(
  node: ts.TryStatement,
  checker: ts.TypeChecker,
  report: (t: ThrownType) => void,
  outerCatchContext?: { variableName: string | undefined; caughtTypes: ThrownType[] },
): void {
  const caughtTypes: ThrownType[] = [];
  const hasCatch = node.catchClause !== undefined;

  // Throws inside the try block are swallowed by the catch clause (if any);
  // otherwise they escape.
  visitForThrows(
    node.tryBlock,
    checker,
    hasCatch ? (t) => caughtTypes.push(t) : report,
    outerCatchContext,
  );

  if (node.catchClause !== undefined) {
    const decl = node.catchClause.variableDeclaration;
    const variableName =
      decl !== undefined && ts.isIdentifier(decl.name) ? decl.name.text : undefined;
    visitForThrows(node.catchClause.block, checker, report, {
      variableName,
      caughtTypes,
    });
  }

  if (node.finallyBlock !== undefined) {
    visitForThrows(node.finallyBlock, checker, report, outerCatchContext);
  }
}

function reportThrowStatement(
  node: ts.ThrowStatement,
  checker: ts.TypeChecker,
  report: (t: ThrownType) => void,
  catchContext?: { variableName: string | undefined; caughtTypes: ThrownType[] },
): void {
  const expr = unwrapParentheses(node.expression);

  // Rethrowing the caught error propagates whatever the try block could throw,
  // unless control flow narrowed the catch variable to a concrete error type.
  if (
    catchContext !== undefined &&
    catchContext.variableName !== undefined &&
    ts.isIdentifier(expr) &&
    expr.text === catchContext.variableName
  ) {
    const narrowed = checker.getTypeAtLocation(expr);
    if ((narrowed.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) === 0) {
      for (const t of typeToThrownTypes(narrowed, node)) report(t);
      return;
    }
    if (catchContext.caughtTypes.length > 0) {
      for (const t of catchContext.caughtTypes) report({ ...t, node });
    } else {
      report({ name: FALLBACK_ERROR_NAME, type: undefined, node });
    }
    return;
  }

  if (ts.isNewExpression(expr)) {
    const name = expr.expression.getText();
    let type: ts.Type | undefined;
    try {
      type = checker.getTypeAtLocation(expr);
    } catch {
      type = undefined;
    }
    report({ name, type, node });
    return;
  }

  const type = checker.getTypeAtLocation(expr);
  const named = typeToThrownTypes(type, node);
  if (named.length > 0) {
    for (const t of named) report(t);
  } else {
    report({ name: FALLBACK_ERROR_NAME, type: undefined, node });
  }
}

function typeToThrownTypes(type: ts.Type, node: ts.Node): ThrownType[] {
  if (type.isUnion()) {
    return type.types.flatMap((t) => typeToThrownTypes(t, node));
  }
  const symbol = type.getSymbol() ?? type.aliasSymbol;
  if (symbol === undefined) return [];
  const name = symbol.getName();
  if (name === "__type" || name === "__object" || name === "unknown") return [];
  return [{ name, type, node }];
}

function reportCallExpression(
  node: ts.CallExpression | ts.NewExpression,
  checker: ts.TypeChecker,
  report: (t: ThrownType) => void,
): void {
  // Promise.reject(x) — rejects with x. Counts when the promise is observed
  // (awaited or returned), same rule as calls to @throws-documented functions.
  if (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    node.expression.expression.getText() === "Promise" &&
    node.expression.name.text === "reject"
  ) {
    if (!isPromiseObserved(node)) return;
    const arg = node.arguments[0];
    if (arg === undefined) {
      report({ name: FALLBACK_ERROR_NAME, type: undefined, node });
      return;
    }
    const unwrapped = unwrapParentheses(arg);
    if (ts.isNewExpression(unwrapped)) {
      report({
        name: unwrapped.expression.getText(),
        type: checker.getTypeAtLocation(unwrapped),
        node,
      });
    } else {
      const types = typeToThrownTypes(checker.getTypeAtLocation(unwrapped), node);
      if (types.length > 0) for (const t of types) report(t);
      else report({ name: FALLBACK_ERROR_NAME, type: undefined, node });
    }
    return;
  }

  const signature = checker.getResolvedSignature(node);
  if (signature === undefined) return;
  const declaration = signature.getDeclaration();
  if (declaration === undefined) return;

  const documented = getDocumentedThrows(declaration as ts.FunctionLikeDeclaration, checker);
  if (documented.length === 0) return;

  // Synchronous callee: its throws surface here unconditionally. Promise
  // returning callee: its rejection surfaces here only when the promise is
  // observed (awaited, returned, or chained) — a fire-and-forget call turns
  // into an unhandled rejection, not a throw in this function.
  const returnsPromise = isPromiseLikeType(checker.getReturnTypeOfSignature(signature), checker);
  if (returnsPromise && !isPromiseObserved(node)) return;
  if (returnsPromise && isRejectionHandled(node)) return;

  for (const d of documented) {
    report({ name: d.name, type: d.type, node });
  }
}

function isPromiseLikeType(type: ts.Type, checker: ts.TypeChecker): boolean {
  const symbol = type.getSymbol() ?? type.aliasSymbol;
  const name = symbol?.getName();
  if (name === "Promise" || name === "PromiseLike") return true;
  // Thenable duck-typing: has a callable `then` member.
  const then = checker.getPropertyOfType(type, "then");
  return then !== undefined && (then.flags & ts.SymbolFlags.Method) !== 0;
}

/**
 * A promise-producing expression's rejection propagates into the enclosing
 * function when the promise is awaited, returned, or chained with `.then`.
 */
function isPromiseObserved(node: ts.Expression): boolean {
  let current: ts.Node = node;
  let parent = current.parent;
  while (parent !== undefined) {
    if (ts.isParenthesizedExpression(parent)) {
      current = parent;
      parent = parent.parent;
      continue;
    }
    if (ts.isAwaitExpression(parent)) return true;
    if (ts.isReturnStatement(parent)) return true;
    // Concise arrow body: `() => doWork()` returns the promise.
    if (ts.isArrowFunction(parent) && parent.body === current) return true;
    // `foo().then(...)` / `foo().finally(...)` keep the rejection in play.
    if (
      ts.isPropertyAccessExpression(parent) &&
      parent.expression === current &&
      (parent.name.text === "then" || parent.name.text === "finally")
    ) {
      return true;
    }
    return false;
  }
  return false;
}

/** `foo().catch(...)` (or `.then(ok, err)`) handles the rejection locally. */
function isRejectionHandled(node: ts.Expression): boolean {
  let current: ts.Node = node;
  let parent = current.parent;
  while (parent !== undefined) {
    if (ts.isParenthesizedExpression(parent) || ts.isAwaitExpression(parent)) {
      current = parent;
      parent = parent.parent;
      continue;
    }
    if (ts.isPropertyAccessExpression(parent) && parent.expression === current) {
      const call = parent.parent;
      if (call !== undefined && ts.isCallExpression(call) && call.expression === parent) {
        if (parent.name.text === "catch") return true;
        if (parent.name.text === "then" && call.arguments.length >= 2) return true;
        // `.then(...)`/`.finally(...)` without a rejection handler: keep looking
        // up the chain for a `.catch`.
        current = call;
        parent = call.parent;
        continue;
      }
    }
    return false;
  }
  return false;
}

function unwrapParentheses(expr: ts.Expression): ts.Expression {
  let current = expr;
  while (ts.isParenthesizedExpression(current)) current = current.expression;
  return current;
}

function functionDisplayName(fn: ts.FunctionLikeDeclaration): string {
  if (fn.name !== undefined && ts.isIdentifier(fn.name)) {
    return `'${fn.name.text}'`;
  }
  if (ts.isConstructorDeclaration(fn)) {
    const cls = fn.parent;
    const clsName = ts.isClassDeclaration(cls) || ts.isClassExpression(cls)
      ? cls.name?.text
      : undefined;
    return clsName !== undefined ? `constructor of '${clsName}'` : "constructor";
  }
  const parent = fn.parent;
  if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) {
    return `'${parent.name.text}'`;
  }
  if (ts.isPropertyAssignment(parent) && ts.isIdentifier(parent.name)) {
    return `'${parent.name.text}'`;
  }
  if (ts.isPropertyDeclaration(parent) && ts.isIdentifier(parent.name)) {
    return `'${parent.name.text}'`;
  }
  return "anonymous function";
}

function formatTypeList(types: string[]): string {
  if (types.length === 1) return `{${types[0]}}`;
  return types.map((t) => `{${t}}`).join(", ");
}

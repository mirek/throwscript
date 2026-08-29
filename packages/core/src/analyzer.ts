import ts from "typescript";

export type DiagnosticKind = "missing-throws" | "unused-throws";
export type Severity = "error" | "warning";

/** A text edit that resolves a diagnostic: replace [start, end) with `text`. */
export interface ThrowsFix {
  start: number;
  end: number;
  text: string;
}

export type ThrowSiteKind = "throw" | "rethrow" | "call" | "reject";

/** A place inside a function where an error type escapes. */
export interface ThrowSite {
  line: number;
  column: number;
  /** The escaping error type name. */
  type: string;
  /**
   * How the error escapes: a `throw` statement, a rethrow of a caught error,
   * a call to a `@throws`-documented function, or a `Promise.reject`.
   */
  kind: ThrowSiteKind;
  /** The single-line source text of the throwing statement or expression. */
  text: string;
  /** For `call` sites: the documented callee that propagates the error. */
  callee?: {
    name: string;
    file: string;
    line: number;
    /** Declared in a `.d.ts` (lib, node_modules) rather than in project code. */
    external: boolean;
  };
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
  /** For `missing-throws`: every site where an undocumented type escapes. */
  sites?: ThrowSite[];
  /** Present when the diagnostic can be auto-fixed (see `applyFixes`). */
  fix?: ThrowsFix;
}

export interface AnalyzeOptions {
  /**
   * Report documented @throws types that the checker cannot see being thrown.
   * Defaults to true (reported as warnings).
   */
  reportUnused?: boolean;
  /**
   * Ignore `@throws` tags on declarations that live in `.d.ts` files (the
   * TypeScript lib, `@types/node`, node_modules). By default a call to e.g.
   * `JSON.parse` propagates its documented `SyntaxError` into the caller.
   */
  ignoreExternal?: boolean;
  /**
   * Restrict reporting to the files this predicate accepts. Files that are
   * only pulled into the program through imports are still used to resolve
   * `@throws` tags on callees, but are not themselves reported on.
   */
  fileFilter?: (fileName: string) => boolean;
  /**
   * Called for non-fatal tsconfig problems (unknown compiler options, lib
   * entries this TypeScript version does not know about, ...). The project
   * is still analyzed; when omitted the problems are silently ignored.
   */
  onConfigWarning?: (message: string) => void;
}

/** A thrown error type observed while walking a function body. */
interface ThrownType {
  name: string;
  /** Resolved type, when available, used for heritage checks against documented types. */
  type: ts.Type | undefined;
  node: ts.Node;
  kind: ThrowSiteKind;
  callee?: ThrowSite["callee"];
}

interface DocumentedType {
  name: string;
  type: ts.Type | undefined;
  tag: ts.JSDocTag;
}

interface Context {
  checker: ts.TypeChecker;
  options: AnalyzeOptions;
}

interface CatchContext {
  variableName: string | undefined;
  caughtTypes: ThrownType[];
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
    if (options.fileFilter !== undefined && !options.fileFilter(sourceFile.fileName)) continue;
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
  const ctx: Context = { checker, options };
  const mutedLines = collectMutedLines(sourceFile);
  const visit = (node: ts.Node): void => {
    if (isCheckableFunction(node)) {
      checkFunction(node, sourceFile, ctx, diagnostics, mutedLines);
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
 * - `// @nothrow` mutes the line the directive is on AND the following line,
 *   so it works both trailing a statement and on its own line above one
 * - `// @nothrow-line` mutes only the line the directive is on
 * - `// @nothrow-next-line` mutes only the following line
 *
 * All forms also work inside block comments; inside a multi-line comment the
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
        if (match[1] !== "-next-line") muted.add(directiveLine);
        if (match[1] !== "-line") muted.add(directiveLine + 1);
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
  ctx: Context,
  diagnostics: ThrowsDiagnostic[],
  mutedLines: Set<number>,
): void {
  // A muted throw site (throw statement, propagating call, Promise.reject)
  // does not count as an observable throw at all.
  const thrown = collectThrownTypes(fn, ctx).filter(
    (t) =>
      !mutedLines.has(
        sourceFile.getLineAndCharacterOfPosition(t.node.getStart(sourceFile)).line,
      ),
  );
  const documented = getDocumentedThrows(fn, ctx.checker);

  const missing = thrown.filter(
    (t) => !documented.some((d) => covers(d, t, ctx.checker)),
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
        sites: missing.map((t) => toThrowSite(t, sourceFile)),
        fix: computeMissingThrowsFix(fn, sourceFile, types),
      });
    }
  }

  if (ctx.options.reportUnused !== false) {
    const unused = documented.filter(
      (d) => !thrown.some((t) => covers(d, t, ctx.checker)),
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

function toThrowSite(t: ThrownType, sourceFile: ts.SourceFile): ThrowSite {
  const pos = sourceFile.getLineAndCharacterOfPosition(t.node.getStart(sourceFile));
  const site: ThrowSite = {
    line: pos.line + 1,
    column: pos.character + 1,
    type: t.name,
    kind: t.kind,
    text: singleLine(t.node.getText(sourceFile)),
  };
  if (t.callee !== undefined) site.callee = t.callee;
  return site;
}

function singleLine(text: string, max = 120): string {
  const collapsed = text.replace(/\s*\n\s*/g, " ").trim();
  return collapsed.length > max ? `${collapsed.slice(0, max - 1)}…` : collapsed;
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
  // Single-line JSDoc (`/** desc */`): rebuild it as a block with the
  // description on its own line followed by the tags.
  const description = text.slice(jsdoc.pos + 3, closeStart).trim();
  const block =
    `/**\n` +
    (description === "" ? "" : `${indent} * ${description}\n`) +
    types.map((t) => `${indent} * @throws {${t}}\n`).join("") +
    `${indent} */`;
  return { start: jsdoc.pos, end: jsdoc.end, text: block };
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
 * Whether a documented @throws type covers a thrown type: same (unqualified)
 * name, or the documented type appears in the thrown type's heritage chain
 * (e.g. `@throws {Error}` covers a thrown `ValidationError extends Error`).
 *
 * Names are compared without their namespace qualifier so that
 * `@throws {JsonRpcError}` covers `throw new Jsonrpc.JsonRpcError()` and vice
 * versa — the qualifier is an import alias, not part of the type's identity.
 *
 * Deliberately nominal rather than structural: `class A extends Error {}` and
 * `class B extends Error {}` are structurally identical, so TypeScript
 * assignability would let a documented A "cover" a thrown B.
 */
function covers(doc: DocumentedType, thrown: ThrownType, checker: ts.TypeChecker): boolean {
  if (unqualified(doc.name) === unqualified(thrown.name)) return true;
  if (thrown.type === undefined) return false;
  return heritageNames(thrown.type, checker).has(unqualified(doc.name));
}

function unqualified(name: string): string {
  const idx = name.lastIndexOf(".");
  return idx === -1 ? name : name.slice(idx + 1);
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

/**
 * Read the `@throws` / `@exception` tags of a function. Besides the canonical
 * `@throws {Type} description` form, the TSDoc-flavoured
 * `@throws {@link Type} description` and the bare `@throws Type description`
 * are understood; `@throws description` with no recognizable type documents
 * the base `Error`.
 */
function getDocumentedThrows(
  fn: ts.SignatureDeclaration,
  checker: ts.TypeChecker,
): DocumentedType[] {
  const result: DocumentedType[] = [];
  for (const tag of ts.getJSDocTags(fn)) {
    const tagName = tag.tagName.text;
    if (tagName !== "throws" && tagName !== "exception") continue;
    const typeExpression = ts.isJSDocThrowsTag(tag) ? tag.typeExpression : undefined;
    if (typeExpression !== undefined && typeExpression.type.getText().trim() !== "") {
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
      continue;
    }
    const name = documentedNameFromText(tag, fn, checker) ?? FALLBACK_ERROR_NAME;
    result.push({ name, type: resolveTypeByName(name, fn, checker), tag });
  }
  return result;
}

const THROWS_TEXT =
  /^@(?:throws|exception)\s*(?:\{\s*@link(?:code|plain)?\s+([\w$][\w$.]*)[^}]*\}|([A-Za-z_$][\w$.]*)(?=[\s,.;:]|$))?/;

/**
 * Recover the documented type from the raw tag text when the JSDoc parser
 * did not produce a type expression: `{@link Type}` (which TypeScript splits
 * into an empty type and a separate `link` tag) or a bare leading `Type`.
 * A bare word only counts as a type when it resolves to something in scope or
 * looks like an error class name — `@throws if empty` documents no type.
 */
function documentedNameFromText(
  tag: ts.JSDocTag,
  location: ts.Node,
  checker: ts.TypeChecker,
): string | undefined {
  const sourceFile = tag.getSourceFile();
  const start = tag.getStart(sourceFile);
  const lineEnd = sourceFile.text.indexOf("\n", start);
  const text = sourceFile.text.slice(start, lineEnd === -1 ? undefined : lineEnd);
  const match = THROWS_TEXT.exec(text);
  if (match === null) return undefined;
  const linked = match[1];
  if (linked !== undefined) return linked;
  const bare = match[2];
  if (bare === undefined) return undefined;
  if (/(Error|Exception)$/.test(bare)) return bare;
  return resolveTypeByName(bare, location, checker) !== undefined ? bare : undefined;
}

/** Resolve a (possibly qualified) type name as seen from `location`, if it names a class/interface. */
function resolveTypeByName(
  name: string,
  location: ts.Node,
  checker: ts.TypeChecker,
): ts.Type | undefined {
  const [head, ...rest] = name.split(".");
  if (head === undefined || head === "") return undefined;
  try {
    let symbol = checker.resolveName(
      head,
      location,
      ts.SymbolFlags.Type | ts.SymbolFlags.Value | ts.SymbolFlags.Namespace,
      /* excludeGlobals */ false,
    );
    for (const segment of rest) {
      if (symbol === undefined) return undefined;
      if (symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
      const exports = checker.getExportsOfModule(symbol);
      symbol = exports.find((s) => s.getName() === segment);
    }
    if (symbol === undefined) return undefined;
    if (symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
    if ((symbol.flags & (ts.SymbolFlags.Class | ts.SymbolFlags.Interface)) === 0) {
      return undefined;
    }
    const type = checker.getDeclaredTypeOfSymbol(symbol);
    return type.flags & ts.TypeFlags.Any ? undefined : type;
  } catch {
    return undefined;
  }
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
function collectThrownTypes(fn: ts.FunctionLikeDeclaration, ctx: Context): ThrownType[] {
  const collected: ThrownType[] = [];
  const body = fn.body;
  if (body === undefined) return collected;
  visitForThrows(body, ctx, (t) => collected.push(t));
  return collected;
}

function visitForThrows(
  node: ts.Node,
  ctx: Context,
  report: (t: ThrownType) => void,
  catchContext?: CatchContext,
): void {
  // Nested functions own their throws; they are checked independently.
  if (ts.isFunctionLike(node)) return;

  if (ts.isTryStatement(node)) {
    visitTryStatement(node, ctx, report, catchContext);
    return;
  }

  if (ts.isThrowStatement(node)) {
    reportThrowStatement(node, ctx, report, catchContext);
    // Still walk the thrown expression: `throw makeError()` may call a
    // @throws-documented factory that itself can throw something else.
    visitForThrows(node.expression, ctx, report, catchContext);
    return;
  }

  if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
    reportCallExpression(node, ctx, report);
    ts.forEachChild(node, (child) => visitForThrows(child, ctx, report, catchContext));
    return;
  }

  ts.forEachChild(node, (child) => visitForThrows(child, ctx, report, catchContext));
}

function visitTryStatement(
  node: ts.TryStatement,
  ctx: Context,
  report: (t: ThrownType) => void,
  outerCatchContext?: CatchContext,
): void {
  const caughtTypes: ThrownType[] = [];
  const hasCatch = node.catchClause !== undefined;

  // Throws inside the try block are swallowed by the catch clause (if any);
  // otherwise they escape.
  visitForThrows(
    node.tryBlock,
    ctx,
    hasCatch ? (t) => caughtTypes.push(t) : report,
    outerCatchContext,
  );

  if (node.catchClause !== undefined) {
    const decl = node.catchClause.variableDeclaration;
    const variableName =
      decl !== undefined && ts.isIdentifier(decl.name) ? decl.name.text : undefined;
    visitForThrows(node.catchClause.block, ctx, report, { variableName, caughtTypes });
  }

  if (node.finallyBlock !== undefined) {
    visitForThrows(node.finallyBlock, ctx, report, outerCatchContext);
  }
}

function reportThrowStatement(
  node: ts.ThrowStatement,
  ctx: Context,
  report: (t: ThrownType) => void,
  catchContext?: CatchContext,
): void {
  const { checker } = ctx;
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
      for (const t of typeToThrownTypes(narrowed, node, "rethrow")) report(t);
      return;
    }
    if (catchContext.caughtTypes.length > 0) {
      for (const t of catchContext.caughtTypes) report({ ...t, node, kind: "rethrow" });
    } else {
      report({ name: FALLBACK_ERROR_NAME, type: undefined, node, kind: "rethrow" });
    }
    return;
  }

  if (ts.isNewExpression(expr)) {
    let type: ts.Type | undefined;
    try {
      type = checker.getTypeAtLocation(expr);
    } catch {
      type = undefined;
    }
    report({ name: thrownTypeName(expr, type), type, node, kind: "throw" });
    return;
  }

  const type = checker.getTypeAtLocation(expr);
  const named = typeToThrownTypes(type, node, "throw");
  if (named.length > 0) {
    for (const t of named) report(t);
  } else {
    report({ name: FALLBACK_ERROR_NAME, type: undefined, node, kind: "throw" });
  }
}

/**
 * Display name for `new X()`: the constructor expression as written
 * (`Jsonrpc.JsonRpcError`), which is what a `@throws` tag in this file can
 * refer to, falling back to the symbol name when the expression is not a
 * plain (qualified) identifier.
 */
function thrownTypeName(expr: ts.NewExpression, type: ts.Type | undefined): string {
  const text = expr.expression.getText();
  if (/^[\w$][\w$.]*$/.test(text)) return text;
  return (type?.getSymbol() ?? type?.aliasSymbol)?.getName() ?? text;
}

function typeToThrownTypes(type: ts.Type, node: ts.Node, kind: ThrowSiteKind): ThrownType[] {
  if (type.isUnion()) {
    return type.types.flatMap((t) => typeToThrownTypes(t, node, kind));
  }
  const symbol = type.getSymbol() ?? type.aliasSymbol;
  if (symbol === undefined) return [];
  const name = symbol.getName();
  if (name === "__type" || name === "__object" || name === "unknown") return [];
  return [{ name, type, node, kind }];
}

function reportCallExpression(
  node: ts.CallExpression | ts.NewExpression,
  ctx: Context,
  report: (t: ThrownType) => void,
): void {
  const { checker } = ctx;
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
      report({ name: FALLBACK_ERROR_NAME, type: undefined, node, kind: "reject" });
      return;
    }
    const unwrapped = unwrapParentheses(arg);
    if (ts.isNewExpression(unwrapped)) {
      const type = checker.getTypeAtLocation(unwrapped);
      report({ name: thrownTypeName(unwrapped, type), type, node, kind: "reject" });
    } else {
      const types = typeToThrownTypes(checker.getTypeAtLocation(unwrapped), node, "reject");
      if (types.length > 0) for (const t of types) report(t);
      else report({ name: FALLBACK_ERROR_NAME, type: undefined, node, kind: "reject" });
    }
    return;
  }

  const signature = checker.getResolvedSignature(node);
  if (signature === undefined) return;
  const declaration = signature.getDeclaration();
  if (declaration === undefined) return;

  const declarationFile = declaration.getSourceFile();
  const external = declarationFile.isDeclarationFile;
  if (external && ctx.options.ignoreExternal === true) return;

  const documented = getDocumentedThrows(declaration, checker);
  if (documented.length === 0) return;

  // Synchronous callee: its throws surface here unconditionally. Promise
  // returning callee: its rejection surfaces here only when the promise is
  // observed (awaited, returned, or chained) — a fire-and-forget call turns
  // into an unhandled rejection, not a throw in this function.
  const returnsPromise = isPromiseLikeType(checker.getReturnTypeOfSignature(signature), checker);
  if (returnsPromise && !isPromiseObserved(node)) return;
  if (returnsPromise && isRejectionHandled(node)) return;

  const callee: ThrowSite["callee"] = {
    name: calleeDisplayName(node, declaration),
    file: declarationFile.fileName,
    line: declarationFile.getLineAndCharacterOfPosition(declaration.getStart(declarationFile)).line + 1,
    external,
  };
  for (const d of documented) {
    report({ name: d.name, type: d.type, node, kind: "call", callee });
  }
}

/** `path.join` / `new Foo` / `foo` — the callee as written at the call site. */
function calleeDisplayName(
  node: ts.CallExpression | ts.NewExpression,
  declaration: ts.SignatureDeclaration,
): string {
  const text = singleLine(node.expression.getText(), 60);
  if (ts.isNewExpression(node)) return `new ${text}`;
  if (/^[\w$][\w$.]*$/.test(text)) return text;
  const declared = ts.getNameOfDeclaration(declaration);
  return declared !== undefined ? declared.getText() : text;
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

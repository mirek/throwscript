import ts from "typescript";
import {
  analyzeProgram,
  type AnalyzeOptions,
  type ThrowsDiagnostic,
  type ThrowSite,
} from "./analyzer.js";

export {
  analyzeProgram,
  analyzeSourceFile,
  collectMutedLines,
  type AnalyzeOptions,
  type DiagnosticKind,
  type Severity,
  type ThrowsDiagnostic,
  type ThrowsFix,
  type ThrowSite,
  type ThrowSiteKind,
} from "./analyzer.js";

const DEFAULT_COMPILER_OPTIONS: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.NodeNext,
  moduleResolution: ts.ModuleResolutionKind.NodeNext,
  strict: true,
  allowJs: true,
  checkJs: false,
  noEmit: true,
  skipLibCheck: true,
};

/**
 * Analyze a list of files with default compiler options. Only the given files
 * are reported on; files they import are used to resolve `@throws` tags.
 */
export function analyzeFiles(
  fileNames: string[],
  options: AnalyzeOptions = {},
  compilerOptions: ts.CompilerOptions = DEFAULT_COMPILER_OPTIONS,
): ThrowsDiagnostic[] {
  const program = ts.createProgram(fileNames, compilerOptions);
  return analyzeProgram(program, withRootFileFilter(options, program.getRootFileNames()));
}

/**
 * Load a tsconfig file and analyze every file in the project. Only files
 * matched by the project itself are reported on — files that are merely
 * imported (e.g. another workspace package resolved through `paths`) are
 * used to resolve `@throws` tags but produce no diagnostics.
 */
export function analyzeProject(
  tsconfigPath: string,
  options: AnalyzeOptions = {},
): ThrowsDiagnostic[] {
  const configFile = ts.readConfigFile(tsconfigPath, ts.sys.readFile);
  if (configFile.error !== undefined) {
    throw new Error(ts.flattenDiagnosticMessageText(configFile.error.messageText, "\n"));
  }
  const parsed = ts.parseJsonConfigFileContent(
    configFile.config,
    ts.sys,
    dirname(tsconfigPath),
  );
  // Like tsc, keep going on option-level problems (e.g. a `lib` entry this
  // TypeScript version does not know about) — the program can still be built
  // and analyzed. Only give up when the config yields nothing to check.
  const configErrors = parsed.errors.map((e) =>
    ts.flattenDiagnosticMessageText(e.messageText, "\n"),
  );
  if (configErrors.length > 0 && parsed.fileNames.length === 0) {
    throw new Error(configErrors.join("\n"));
  }
  for (const message of configErrors) options.onConfigWarning?.(message);

  const program = ts.createProgram(parsed.fileNames, {
    ...parsed.options,
    noEmit: true,
  });
  return analyzeProgram(program, withRootFileFilter(options, program.getRootFileNames()));
}

function withRootFileFilter(
  options: AnalyzeOptions,
  rootFileNames: readonly string[],
): AnalyzeOptions {
  if (options.fileFilter !== undefined) return options;
  const roots = new Set(rootFileNames.map(normalizePath));
  return { ...options, fileFilter: (fileName) => roots.has(normalizePath(fileName)) };
}

function normalizePath(p: string): string {
  return ts.sys.resolvePath(p).replace(/\\/g, "/");
}

/**
 * Apply the auto-fixes carried by the given diagnostics and return the new
 * file contents, keyed by file name. Overlapping and duplicate fixes are
 * applied once; files without fixable diagnostics are omitted. The caller is
 * responsible for writing the results to disk.
 */
export function applyFixes(
  diagnostics: ThrowsDiagnostic[],
  readFile: (fileName: string) => string | undefined = ts.sys.readFile,
): Map<string, string> {
  const byFile = new Map<string, ThrowsDiagnostic["fix"][]>();
  for (const d of diagnostics) {
    if (d.fix === undefined) continue;
    const fixes = byFile.get(d.file) ?? [];
    fixes.push(d.fix);
    byFile.set(d.file, fixes);
  }

  const results = new Map<string, string>();
  for (const [file, fixes] of byFile) {
    const original = readFile(file);
    if (original === undefined) continue;
    const seen = new Set<string>();
    const unique = fixes
      .filter((f): f is NonNullable<typeof f> => f !== undefined)
      .filter((f) => {
        const key = `${f.start}:${f.end}:${f.text}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .toSorted((a, b) => b.start - a.start);

    let text = original;
    let lastApplied = Number.POSITIVE_INFINITY;
    for (const fix of unique) {
      if (fix.end > lastApplied) continue; // overlaps a fix already applied
      text = text.slice(0, fix.start) + fix.text + text.slice(fix.end);
      lastApplied = fix.start;
    }
    results.set(file, text);
  }
  return results;
}

/** Render a diagnostic as `file:line:col severity message`. */
export function formatDiagnostic(d: ThrowsDiagnostic, cwd?: string): string {
  return `${relativeTo(d.file, cwd)}:${d.line}:${d.column} ${d.severity} ${d.message}`;
}

/**
 * Render diagnostics as a Markdown report meant to be handed to a reviewer —
 * human or LLM — who decides, per function, whether to document the throw,
 * handle it locally, or mute it. Every throw site is listed with its source
 * text and, for propagated throws, the callee that documents the error.
 */
export function formatReport(diagnostics: ThrowsDiagnostic[], cwd?: string): string {
  const missing = diagnostics.filter((d) => d.kind === "missing-throws");
  const unused = diagnostics.filter((d) => d.kind === "unused-throws");
  const out: string[] = ["# throwscript report", ""];

  if (diagnostics.length === 0) {
    out.push("No problems found: every function that can throw documents it with `@throws`.", "");
    return out.join("\n");
  }

  out.push(
    `${plural(missing.length, "function")} can throw without a matching \`@throws\` tag; ` +
      `${plural(unused.length, "documented tag")} ${unused.length === 1 ? "is" : "are"} never observed to throw.`,
    "",
    "For each function under **Missing `@throws`**, pick one:",
    "",
    "1. **Document it** — add `@throws {Type} when …` to the function's JSDoc " +
      "(`throwscript --fix` inserts the tag without a description) when throwing is part of the contract.",
    "2. **Handle it** — catch the error locally, return a result/`undefined`, or validate " +
      "inputs up front, when the caller should not have to deal with it.",
    "3. **Mute it** — append `// @nothrow` to a throw site that is a deliberate " +
      "programmer-error guard (assertion, unreachable branch) not worth documenting.",
    "",
    "Sites marked *(external)* propagate a `@throws` documented in a `.d.ts` " +
      "(TypeScript lib, `@types/node`); run with `--no-external` to ignore those.",
    "",
    "Each `@throws` under **Unused `@throws`** is either stale (delete it) or documents a " +
      "throw the checker cannot see, e.g. from an undocumented callee (document the callee instead).",
    "",
  );

  if (missing.length > 0) {
    out.push("## Missing `@throws`", "");
    for (const [file, group] of groupByFile(missing)) {
      out.push(`### ${relativeTo(file, cwd)}`, "");
      for (const d of group) {
        out.push(
          `- **${d.functionName}** (line ${d.line}) — add ` +
            d.types.map((t) => `\`@throws {${t}}\``).join(", "),
        );
        for (const site of d.sites ?? []) out.push(`  - ${formatSite(site, cwd)}`);
      }
      out.push("");
    }
  }

  if (unused.length > 0) {
    out.push("## Unused `@throws`", "");
    for (const [file, group] of groupByFile(unused)) {
      out.push(`### ${relativeTo(file, cwd)}`, "");
      for (const d of group) {
        out.push(
          `- **${d.functionName}** (line ${d.line}) — \`@throws {${d.types[0]}}\` ` +
            "is never observed to throw",
        );
      }
      out.push("");
    }
  }

  return out.join("\n");
}

function formatSite(site: ThrowSite, cwd?: string): string {
  const where = `line ${site.line}`;
  const code = `\`${site.text.replace(/`/g, "\\`")}\``;
  switch (site.kind) {
    case "throw":
      return `${where}: throws \`${site.type}\` — ${code}`;
    case "rethrow":
      return `${where}: rethrows \`${site.type}\` — ${code}`;
    case "reject":
      return `${where}: rejects with \`${site.type}\` — ${code}`;
    case "call": {
      const callee = site.callee;
      const origin =
        callee === undefined
          ? ""
          : ` via \`${callee.name}\` (${relativeTo(callee.file, cwd)}:${callee.line})` +
            (callee.external ? " *(external)*" : "");
      return `${where}: propagates \`${site.type}\`${origin} — ${code}`;
    }
  }
}

function groupByFile(
  diagnostics: ThrowsDiagnostic[],
): Map<string, ThrowsDiagnostic[]> {
  const groups = new Map<string, ThrowsDiagnostic[]>();
  for (const d of diagnostics) {
    const list = groups.get(d.file) ?? [];
    list.push(d);
    groups.set(d.file, list);
  }
  return groups;
}

function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

function relativeTo(file: string, cwd?: string): string {
  if (cwd === undefined) return file;
  const normalizedCwd = cwd.replace(/\\/g, "/");
  return file.startsWith(normalizedCwd)
    ? file.slice(normalizedCwd.length).replace(/^[/\\]/, "")
    : file;
}

function dirname(p: string): string {
  const normalized = p.replace(/\\/g, "/");
  const idx = normalized.lastIndexOf("/");
  return idx === -1 ? "." : normalized.slice(0, idx);
}

import ts from "typescript";
import {
  analyzeProgram,
  type AnalyzeOptions,
  type ThrowsDiagnostic,
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

/** Analyze a list of files with default compiler options. */
export function analyzeFiles(
  fileNames: string[],
  options: AnalyzeOptions = {},
  compilerOptions: ts.CompilerOptions = DEFAULT_COMPILER_OPTIONS,
): ThrowsDiagnostic[] {
  const program = ts.createProgram(fileNames, compilerOptions);
  return analyzeProgram(program, options);
}

/** Load a tsconfig file and analyze every file in the project. */
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
  if (parsed.errors.length > 0) {
    throw new Error(
      parsed.errors
        .map((e) => ts.flattenDiagnosticMessageText(e.messageText, "\n"))
        .join("\n"),
    );
  }
  const program = ts.createProgram(parsed.fileNames, {
    ...parsed.options,
    noEmit: true,
  });
  return analyzeProgram(program, options);
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
      .sort((a, b) => b.start - a.start);

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
  const file =
    cwd !== undefined && d.file.startsWith(cwd)
      ? d.file.slice(cwd.length).replace(/^[/\\]/, "")
      : d.file;
  return `${file}:${d.line}:${d.column} ${d.severity} ${d.message}`;
}

function dirname(p: string): string {
  const normalized = p.replace(/\\/g, "/");
  const idx = normalized.lastIndexOf("/");
  return idx === -1 ? "." : normalized.slice(0, idx);
}

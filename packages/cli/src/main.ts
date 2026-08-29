#!/usr/bin/env node
import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import {
  analyzeFiles,
  analyzeProject,
  applyFixes,
  formatDiagnostic,
  formatReport,
  type AnalyzeOptions,
  type ThrowsDiagnostic,
} from "@throwscript/core";

const VERSION = "0.4.0";

const HELP = `throwscript — assert every function that can throw has a JSDoc @throws tag

Usage:
  throwscript [options] [files...]

When no files are given, throwscript looks for a tsconfig.json in the current
directory and checks every file in the project. Async / Promise-returning
functions are handled implicitly: a rejection must be documented with the same
\`@throws {ErrorType}\` tag as a synchronous throw.

Muting (eslint-style):
  // @nothrow             mutes this line AND the next line
  // @nothrow-line        mutes only this line
  // @nothrow-next-line   mutes only the following line

Options:
  -p, --project <tsconfig>  Check all files from the given tsconfig project
  --fix                     Insert missing @throws tags into JSDoc comments,
                            repeating until no fixable problem remains
  --no-unused               Do not warn about @throws tags that never throw
  --no-external             Ignore @throws documented in .d.ts files (lib, @types)
  -f, --format <fmt>        Output format: text (default), json, markdown
  --json                    Shorthand for --format json
  -h, --help                Show this help
  -v, --version             Show version
`;

type Format = "text" | "json" | "markdown";

interface CliOptions {
  project: string | undefined;
  files: string[];
  reportUnused: boolean;
  ignoreExternal: boolean;
  format: Format;
  fix: boolean;
}

/** Upper bound on --fix rounds: each round documents one more layer of callers. */
const MAX_FIX_ROUNDS = 20;

function parseArgs(argv: string[]): CliOptions | "help" | "version" {
  const options: CliOptions = {
    project: undefined,
    files: [],
    reportUnused: true,
    ignoreExternal: false,
    format: "text",
    fix: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;
    switch (arg) {
      case "-h":
      case "--help":
        return "help";
      case "-v":
      case "--version":
        return "version";
      case "-p":
      case "--project": {
        const value = argv[++i];
        if (value === undefined) {
          throw new UsageError("--project requires a path to a tsconfig file");
        }
        options.project = value;
        break;
      }
      case "-f":
      case "--format": {
        const value = argv[++i];
        if (value !== "text" && value !== "json" && value !== "markdown") {
          throw new UsageError("--format must be one of: text, json, markdown");
        }
        options.format = value;
        break;
      }
      case "--fix":
        options.fix = true;
        break;
      case "--no-unused":
        options.reportUnused = false;
        break;
      case "--no-external":
        options.ignoreExternal = true;
        break;
      case "--json":
        options.format = "json";
        break;
      default:
        if (arg.startsWith("-")) {
          throw new UsageError(`Unknown option: ${arg}`);
        }
        options.files.push(arg);
    }
  }
  return options;
}

class UsageError extends Error {}

/**
 * @throws {UsageError} when the command line is invalid
 */
function analyze(options: CliOptions): ThrowsDiagnostic[] {
  const analyzeOptions: AnalyzeOptions = {
    reportUnused: options.reportUnused,
    ignoreExternal: options.ignoreExternal,
    onConfigWarning: (message: string) => console.error(`warning: ${message}`),
  };
  if (options.files.length > 0) {
    if (options.project !== undefined) {
      throw new UsageError("pass either --project or a list of files, not both");
    }
    const missing = options.files.filter((f) => !existsSync(f));
    if (missing.length > 0) {
      throw new UsageError(`file not found: ${missing.join(", ")}`);
    }
    const targets = new Set(options.files.map((f) => path.resolve(f)));
    return analyzeFiles([...targets], analyzeOptions);
  }
  const tsconfig = options.project ?? path.join(process.cwd(), "tsconfig.json");
  if (!existsSync(tsconfig)) {
    throw new UsageError(
      options.project !== undefined
        ? `tsconfig not found: ${tsconfig}`
        : "no files given and no tsconfig.json found in the current directory",
    );
  }
  return analyzeProject(tsconfig, analyzeOptions);
}

/**
 * Documenting a callee makes its callers' `@throws` tags incomplete in turn,
 * so apply fixes and re-analyze until nothing fixable is left (or the round
 * limit is hit). Returns the final diagnostics and the number of fixes made.
 *
 * @throws {UsageError} when the command line is invalid
 */
function analyzeAndFix(options: CliOptions): { diagnostics: ThrowsDiagnostic[]; fixed: number } {
  let diagnostics = analyze(options);
  let fixed = 0;
  for (let round = 0; round < MAX_FIX_ROUNDS; round++) {
    const fixable = diagnostics.filter((d) => d.fix !== undefined);
    if (fixable.length === 0) break;
    const updated = applyFixes(diagnostics);
    if (updated.size === 0) break;
    for (const [file, text] of updated) writeFileSync(file, text);
    fixed += fixable.length;
    diagnostics = analyze(options);
  }
  return { diagnostics, fixed };
}

function run(): number {
  let parsed: CliOptions | "help" | "version";
  try {
    parsed = parseArgs(process.argv.slice(2));
  } catch (error) {
    if (error instanceof UsageError) {
      console.error(`error: ${error.message}\n`);
      console.error(HELP);
      return 2;
    }
    throw error;
  }

  if (parsed === "help") {
    console.log(HELP);
    return 0;
  }
  if (parsed === "version") {
    console.log(`throwscript ${VERSION}`);
    return 0;
  }

  const cwd = process.cwd();
  let diagnostics: ThrowsDiagnostic[];
  let fixedCount = 0;

  try {
    if (parsed.fix) {
      ({ diagnostics, fixed: fixedCount } = analyzeAndFix(parsed));
    } else {
      diagnostics = analyze(parsed);
    }
  } catch (error) {
    if (error instanceof UsageError) {
      console.error(`error: ${error.message}`);
      return 2;
    }
    console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }

  diagnostics.sort(
    (a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.column - b.column,
  );

  const errors = diagnostics.filter((d) => d.severity === "error").length;
  const warnings = diagnostics.length - errors;
  const fixedNote =
    fixedCount > 0 ? ` (${fixedCount} problem${fixedCount === 1 ? "" : "s"} fixed)` : "";

  switch (parsed.format) {
    case "json":
      console.log(JSON.stringify(diagnostics, null, 2));
      break;
    case "markdown":
      console.log(formatReport(diagnostics, cwd));
      if (fixedCount > 0) console.error(`throwscript:${fixedNote.trim()}`);
      break;
    case "text":
      for (const d of diagnostics) {
        console.log(formatDiagnostic(d, cwd));
      }
      if (diagnostics.length === 0) {
        console.log(`throwscript: no problems found${fixedNote}`);
      } else {
        console.log(
          `\nthrowscript: ${errors} error${errors === 1 ? "" : "s"}, ` +
            `${warnings} warning${warnings === 1 ? "" : "s"}${fixedNote}`,
        );
      }
      break;
  }

  return errors > 0 ? 1 : 0;
}

process.exitCode = run();

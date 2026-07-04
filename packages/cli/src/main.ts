#!/usr/bin/env node
import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import {
  analyzeFiles,
  analyzeProject,
  applyFixes,
  formatDiagnostic,
  type ThrowsDiagnostic,
} from "@throwscript/core";

const HELP = `throwscript — assert every function that can throw has a JSDoc @throws tag

Usage:
  throwscript [options] [files...]

When no files are given, throwscript looks for a tsconfig.json in the current
directory and checks every file in the project. Async / Promise-returning
functions are handled implicitly: a rejection must be documented with the same
\`@throws {ErrorType}\` tag as a synchronous throw.

Muting (eslint-style):
  // @nothrow             trailing comment mutes the throw/call on that line
  // @nothrow-line        same as @nothrow
  // @nothrow-next-line   mutes the following line

Options:
  -p, --project <tsconfig>  Check all files from the given tsconfig project
  --fix                     Insert missing @throws tags into JSDoc comments
  --no-unused               Do not warn about @throws tags that never throw
  --json                    Emit diagnostics as JSON
  -h, --help                Show this help
  -v, --version             Show version
`;

interface CliOptions {
  project: string | undefined;
  files: string[];
  reportUnused: boolean;
  json: boolean;
  fix: boolean;
}

function parseArgs(argv: string[]): CliOptions | "help" | "version" {
  const options: CliOptions = {
    project: undefined,
    files: [],
    reportUnused: true,
    json: false,
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
      case "--fix":
        options.fix = true;
        break;
      case "--no-unused":
        options.reportUnused = false;
        break;
      case "--json":
        options.json = true;
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
  const analyzeOptions = { reportUnused: options.reportUnused };
  if (options.files.length > 0) {
    if (options.project !== undefined) {
      throw new UsageError("pass either --project or a list of files, not both");
    }
    const missing = options.files.filter((f) => !existsSync(f));
    if (missing.length > 0) {
      throw new UsageError(`file not found: ${missing.join(", ")}`);
    }
    const targets = new Set(options.files.map((f) => path.resolve(f)));
    return analyzeFiles([...targets], analyzeOptions).filter((d) =>
      targets.has(path.resolve(d.file)),
    );
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
    console.log("throwscript 0.2.0");
    return 0;
  }

  const cwd = process.cwd();
  let diagnostics: ThrowsDiagnostic[];
  let fixedCount = 0;

  try {
    diagnostics = analyze(parsed);
    if (parsed.fix) {
      const fixable = diagnostics.filter((d) => d.fix !== undefined);
      const updated = applyFixes(diagnostics);
      for (const [file, text] of updated) {
        writeFileSync(file, text);
      }
      if (updated.size > 0) {
        fixedCount = fixable.length;
        diagnostics = analyze(parsed);
      }
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

  if (parsed.json) {
    console.log(JSON.stringify(diagnostics, null, 2));
  } else {
    for (const d of diagnostics) {
      console.log(formatDiagnostic(d, cwd));
    }
    const errors = diagnostics.filter((d) => d.severity === "error").length;
    const warnings = diagnostics.length - errors;
    const fixedNote =
      fixedCount > 0
        ? ` (${fixedCount} problem${fixedCount === 1 ? "" : "s"} fixed)`
        : "";
    if (diagnostics.length === 0) {
      console.log(`throwscript: no problems found${fixedNote}`);
    } else {
      console.log(
        `\nthrowscript: ${errors} error${errors === 1 ? "" : "s"}, ` +
          `${warnings} warning${warnings === 1 ? "" : "s"}${fixedNote}`,
      );
    }
  }

  return diagnostics.some((d) => d.severity === "error") ? 1 : 0;
}

process.exitCode = run();

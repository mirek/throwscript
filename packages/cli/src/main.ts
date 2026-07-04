#!/usr/bin/env node
import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import {
  analyzeFiles,
  analyzeProject,
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

Options:
  -p, --project <tsconfig>  Check all files from the given tsconfig project
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
}

function parseArgs(argv: string[]): CliOptions | "help" | "version" {
  const options: CliOptions = {
    project: undefined,
    files: [],
    reportUnused: true,
    json: false,
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
    console.log("throwscript 0.1.0");
    return 0;
  }

  const analyzeOptions = { reportUnused: parsed.reportUnused };
  let diagnostics: ThrowsDiagnostic[];
  const cwd = process.cwd();

  try {
    if (parsed.files.length > 0) {
      if (parsed.project !== undefined) {
        console.error("error: pass either --project or a list of files, not both\n");
        return 2;
      }
      const missing = parsed.files.filter((f) => !existsSync(f));
      if (missing.length > 0) {
        console.error(`error: file not found: ${missing.join(", ")}`);
        return 2;
      }
      diagnostics = analyzeFiles(
        parsed.files.map((f) => path.resolve(f)),
        analyzeOptions,
      );
      const targets = new Set(parsed.files.map((f) => path.resolve(f)));
      diagnostics = diagnostics.filter((d) => targets.has(path.resolve(d.file)));
    } else {
      const tsconfig = parsed.project ?? path.join(cwd, "tsconfig.json");
      if (!existsSync(tsconfig)) {
        console.error(
          parsed.project !== undefined
            ? `error: tsconfig not found: ${tsconfig}`
            : "error: no files given and no tsconfig.json found in the current directory",
        );
        console.error(HELP);
        return 2;
      }
      diagnostics = analyzeProject(tsconfig, analyzeOptions);
    }
  } catch (error) {
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
    if (diagnostics.length === 0) {
      console.log("throwscript: no problems found");
    } else {
      console.log(
        `\nthrowscript: ${errors} error${errors === 1 ? "" : "s"}, ` +
          `${warnings} warning${warnings === 1 ? "" : "s"}`,
      );
    }
  }

  return diagnostics.some((d) => d.severity === "error") ? 1 : 0;
}

process.exitCode = run();

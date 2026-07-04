import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const entry = path.join(here, "..", "src", "main.ts");
const fixture = path.join(here, "fixtures", "sample.ts");

interface CliResult {
  status: number;
  stdout: string;
  stderr: string;
}

function runCli(args: string[]): CliResult {
  try {
    const stdout = execFileSync(
      process.execPath,
      ["--import", "tsx", entry, ...args],
      { encoding: "utf8" },
    );
    return { status: 0, stdout, stderr: "" };
  } catch (error) {
    const e = error as { status?: number; stdout?: string; stderr?: string };
    return {
      status: e.status ?? -1,
      stdout: e.stdout?.toString() ?? "",
      stderr: e.stderr?.toString() ?? "",
    };
  }
}

test("reports undocumented throws and exits 1", () => {
  const result = runCli([fixture]);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /undocumented.*can throw \{BoomError\}/);
  assert.match(result.stdout, /1 error/);
  assert.doesNotMatch(result.stdout, /'documented'/);
});

test("--json emits machine-readable diagnostics", () => {
  const result = runCli(["--json", fixture]);
  assert.equal(result.status, 1);
  const parsed = JSON.parse(result.stdout) as Array<{
    kind: string;
    functionName: string;
    types: string[];
  }>;
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0]?.kind, "missing-throws");
  assert.equal(parsed[0]?.functionName, "'undocumented'");
  assert.deepEqual(parsed[0]?.types, ["BoomError"]);
});

test("--help exits 0", () => {
  const result = runCli(["--help"]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Usage:/);
});

test("unknown option exits 2", () => {
  const result = runCli(["--nope"]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Unknown option/);
});

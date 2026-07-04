import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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

test("--fix inserts the missing @throws tags and exits 0", () => {
  const workDir = mkdtempSync(path.join(tmpdir(), "throwscript-cli-fix-"));
  try {
    const target = path.join(workDir, "sample.ts");
    cpSync(fixture, target);

    const fixRun = runCli(["--fix", target]);
    assert.equal(fixRun.status, 0, fixRun.stdout + fixRun.stderr);
    assert.match(fixRun.stdout, /no problems found \(1 problem fixed\)/);

    const fixedText = readFileSync(target, "utf8");
    assert.match(
      fixedText,
      /\/\*\*\n \* @throws \{BoomError\}\n \*\/\nexport function undocumented/,
    );

    // A second, plain run confirms the file is clean.
    const verifyRun = runCli([target]);
    assert.equal(verifyRun.status, 0, verifyRun.stdout + verifyRun.stderr);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});

test("@nothrow mutes a diagnostic from the CLI", () => {
  const workDir = mkdtempSync(path.join(tmpdir(), "throwscript-cli-mute-"));
  try {
    const target = path.join(workDir, "muted.ts");
    const original = readFileSync(fixture, "utf8");
    const muted = original.replace(
      'throw new BoomError("boom");\n}\n\n/**',
      'throw new BoomError("boom"); // @nothrow\n}\n\n/**',
    );
    assert.notEqual(muted, original, "fixture rewrite must apply");
    writeFileSync(target, muted);

    const result = runCli([target]);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /no problems found/);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
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

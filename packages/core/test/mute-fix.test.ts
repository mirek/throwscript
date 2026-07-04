import assert from "node:assert/strict";
import { test } from "node:test";
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { analyzeFiles, applyFixes, type ThrowsDiagnostic } from "../src/index.js";

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");

function analyzeFixture(name: string): ThrowsDiagnostic[] {
  return analyzeFiles([path.join(fixturesDir, name)]).filter((d) =>
    d.file.endsWith(name),
  );
}

function errorsFor(diagnostics: ThrowsDiagnostic[], fnName: string): ThrowsDiagnostic[] {
  return diagnostics.filter(
    (d) => d.kind === "missing-throws" && d.functionName === `'${fnName}'`,
  );
}

test("@nothrow directives mute throw sites and diagnostics", () => {
  const diagnostics = analyzeFixture("muted.ts");

  assert.equal(errorsFor(diagnostics, "mutedSameLine").length, 0);
  assert.equal(errorsFor(diagnostics, "mutedLineSuffix").length, 0);
  assert.equal(errorsFor(diagnostics, "mutedNextLine").length, 0);
  assert.equal(errorsFor(diagnostics, "mutedFunction").length, 0);
  assert.equal(errorsFor(diagnostics, "mutedCall").length, 0);

  const notMuted = errorsFor(diagnostics, "notMuted");
  assert.equal(notMuted.length, 1);
  assert.deepEqual(notMuted[0]?.types, ["MutedError"]);

  const partial = errorsFor(diagnostics, "partiallyMuted");
  assert.equal(partial.length, 1);
  assert.deepEqual(partial[0]?.types, ["OtherError"]);
});

test("@nothrow on a @throws tag line mutes the unused warning", () => {
  const diagnostics = analyzeFixture("muted.ts");
  const unused = diagnostics.filter((d) => d.kind === "unused-throws");
  assert.equal(unused.length, 1);
  assert.equal(unused[0]?.functionName, "'overDocumentedReported'");
});

test("missing-throws diagnostics carry fixes; applyFixes resolves them", () => {
  const workDir = mkdtempSync(path.join(tmpdir(), "throwscript-fix-"));
  try {
    const target = path.join(workDir, "fixable.ts");
    cpSync(path.join(fixturesDir, "fixable.ts"), target);

    const before = analyzeFiles([target]).filter((d) => d.kind === "missing-throws");
    assert.equal(before.length, 6);
    for (const d of before) {
      assert.notEqual(d.fix, undefined, `fix for ${d.functionName}`);
    }

    const updated = applyFixes(before);
    assert.equal(updated.size, 1);
    const newText = updated.get(target);
    assert.ok(newText !== undefined);
    writeFileSync(target, newText);

    // New JSDoc block created above an undocumented function.
    assert.match(newText, /\/\*\*\n \* @throws \{FixError\}\n \*\/\nexport function noDoc/);
    // Tag appended inside an existing multi-line JSDoc.
    assert.match(newText, /Existing multi-line docs\.\n \* @throws \{FixError\}\n \*\//);
    // Single-line JSDoc broken open.
    assert.match(newText, /\/\*\* One-liner\. \n \* @throws \{FixError\}\n \*\//);
    // Arrow: block sits above the variable statement.
    assert.match(newText, /\/\*\*\n \* @throws \{FixError\}\n \*\/\nexport const arrow/);
    // Method: indentation matches the class body.
    assert.match(newText, /  \/\*\*\n   \* @throws \{FixError\}\n   \*\/\n  method/);
    // Both missing types are inserted for twoTypes.
    assert.match(
      newText,
      /\* @throws \{FixError\}\n \* @throws \{SecondError\}\n \*\/\nexport function twoTypes/,
    );

    // The fixed file is clean: no missing-throws, no unused-throws.
    const after = analyzeFiles([target]).filter((d) => d.file.endsWith("fixable.ts"));
    assert.deepEqual(after, []);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});

test("applyFixes deduplicates identical edits", () => {
  const diagnostic: ThrowsDiagnostic = {
    kind: "missing-throws",
    severity: "error",
    file: "virtual.ts",
    line: 1,
    column: 1,
    functionName: "'x'",
    types: ["E"],
    message: "m",
    fix: { start: 0, end: 0, text: "/** @throws {E} */\n" },
  };
  const updated = applyFixes([diagnostic, { ...diagnostic }], () => "const a = 1;\n");
  assert.equal(updated.get("virtual.ts"), "/** @throws {E} */\nconst a = 1;\n");
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { analyzeFiles, type ThrowsDiagnostic } from "../src/index.js";

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");

function fixture(name: string): string {
  return path.join(fixturesDir, name);
}

function analyzeFixture(name: string): ThrowsDiagnostic[] {
  return analyzeFiles([fixture(name)]).filter((d) => d.file.endsWith(name));
}

function errorsFor(diagnostics: ThrowsDiagnostic[], fnName: string): ThrowsDiagnostic[] {
  return diagnostics.filter(
    (d) => d.kind === "missing-throws" && d.functionName === `'${fnName}'`,
  );
}

test("basic sync functions", () => {
  const diagnostics = analyzeFixture("basic.ts");

  const missingTag = errorsFor(diagnostics, "missingTag");
  assert.equal(missingTag.length, 1);
  assert.deepEqual(missingTag[0]?.types, ["ValidationError"]);

  assert.equal(errorsFor(diagnostics, "documented").length, 0);
  assert.equal(errorsFor(diagnostics, "documentedViaBaseClass").length, 0);

  const partial = errorsFor(diagnostics, "partiallyDocumented");
  assert.equal(partial.length, 1);
  assert.deepEqual(partial[0]?.types, ["TimeoutError"]);

  assert.equal(errorsFor(diagnostics, "safe").length, 0);
  assert.equal(errorsFor(diagnostics, "swallowed").length, 0);

  const rethrows = errorsFor(diagnostics, "rethrows");
  assert.equal(rethrows.length, 1);
  assert.deepEqual(rethrows[0]?.types, ["TimeoutError"]);
});

test("call propagation through @throws-documented callees", () => {
  const diagnostics = analyzeFixture("basic.ts");

  const caller = errorsFor(diagnostics, "callsDocumented");
  assert.equal(caller.length, 1);
  assert.deepEqual(caller[0]?.types, ["NotFoundError"]);

  assert.equal(errorsFor(diagnostics, "callsDocumentedAndDocuments").length, 0);
  assert.equal(errorsFor(diagnostics, "callsDocumentedAndCatches").length, 0);
});

test("unused @throws tags are reported as warnings", () => {
  const diagnostics = analyzeFixture("basic.ts");
  const unused = diagnostics.filter((d) => d.kind === "unused-throws");
  assert.equal(unused.length, 1);
  assert.equal(unused[0]?.functionName, "'overDocumented'");
  assert.deepEqual(unused[0]?.types, ["ValidationError"]);
  assert.equal(unused[0]?.severity, "warning");

  const withoutUnused = analyzeFiles([fixture("basic.ts")], { reportUnused: false });
  assert.equal(withoutUnused.filter((d) => d.kind === "unused-throws").length, 0);
});

test("async functions and promise rejections", () => {
  const diagnostics = analyzeFixture("async.ts");

  const missing = errorsFor(diagnostics, "fetchMissingTag");
  assert.equal(missing.length, 1);
  assert.deepEqual(missing[0]?.types, ["NetworkError"]);

  assert.equal(errorsFor(diagnostics, "fetchDocumented").length, 0);

  const awaited = errorsFor(diagnostics, "awaitsDocumented");
  assert.equal(awaited.length, 1);
  assert.deepEqual(awaited[0]?.types, ["NetworkError"]);

  const returned = errorsFor(diagnostics, "returnsPromiseDirectly");
  assert.equal(returned.length, 1);
  assert.deepEqual(returned[0]?.types, ["NetworkError"]);

  assert.equal(errorsFor(diagnostics, "fireAndForget").length, 0);
  assert.equal(errorsFor(diagnostics, "handledWithCatch").length, 0);
  assert.equal(errorsFor(diagnostics, "handledWithTry").length, 0);

  const rejects = errorsFor(diagnostics, "rejectsExplicitly");
  assert.equal(rejects.length, 1);
  assert.deepEqual(rejects[0]?.types, ["ParseError"]);

  assert.equal(errorsFor(diagnostics, "rejectsDocumented").length, 0);
});

test("arrow functions, methods, and narrowed rethrows", () => {
  const diagnostics = analyzeFixture("expressions.ts");

  const arrow = errorsFor(diagnostics, "parseConfig");
  assert.equal(arrow.length, 1);
  assert.deepEqual(arrow[0]?.types, ["ConfigError"]);

  assert.equal(errorsFor(diagnostics, "parseConfigDocumented").length, 0);

  const method = errorsFor(diagnostics, "get");
  assert.equal(method.length, 1);
  assert.deepEqual(method[0]?.types, ["ConfigError"]);

  assert.equal(errorsFor(diagnostics, "getDocumented").length, 0);
  assert.equal(errorsFor(diagnostics, "has").length, 0);

  const narrowed = errorsFor(diagnostics, "narrowedRethrow");
  assert.equal(narrowed.length, 1);
  assert.deepEqual(narrowed[0]?.types, ["ConfigError"]);
});

test("diagnostics carry usable positions", () => {
  const diagnostics = analyzeFixture("basic.ts");
  for (const d of diagnostics) {
    assert.ok(d.line >= 1, `line for ${d.functionName}`);
    assert.ok(d.column >= 1, `column for ${d.functionName}`);
    assert.ok(d.message.length > 0);
  }
});

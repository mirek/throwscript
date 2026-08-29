import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  analyzeFiles,
  analyzeProject,
  formatReport,
  type ThrowsDiagnostic,
} from "../src/index.js";

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");

function fixture(name: string): string {
  return path.join(fixturesDir, name);
}

function errorsFor(diagnostics: ThrowsDiagnostic[], fnName: string): ThrowsDiagnostic[] {
  return diagnostics.filter(
    (d) => d.kind === "missing-throws" && d.functionName === `'${fnName}'`,
  );
}

test("@throws tag forms: {@link T}, bare T, description-only, qualified names", () => {
  const diagnostics = analyzeFiles([fixture("jsdoc-forms.ts")]);

  for (const fn of [
    "linkForm",
    "bareForm",
    "descriptionOnly",
    "capitalizedDescription",
    "qualifiedThrowUnqualifiedDoc",
    "qualifiedDoc",
  ]) {
    assert.equal(errorsFor(diagnostics, fn).length, 0, `${fn} should be documented`);
  }
  assert.deepEqual(
    diagnostics.filter((d) => d.kind === "unused-throws"),
    [],
    "every documented tag is observed",
  );

  // A `{@link T}` tag propagates T (not an empty name) to callers.
  const viaLink = errorsFor(diagnostics, "callsLinkForm");
  assert.equal(viaLink.length, 1);
  assert.deepEqual(viaLink[0]?.types, ["LinkedError"]);

  const viaQualified = errorsFor(diagnostics, "callsQualified");
  assert.equal(viaQualified.length, 1);
  assert.deepEqual(viaQualified[0]?.types, ["QualifiedError"]);
});

test("analyzeFiles reports only the requested files", () => {
  const diagnostics = analyzeFiles([fixture("jsdoc-forms.ts")]);
  assert.ok(diagnostics.length > 0);
  for (const d of diagnostics) assert.ok(d.file.endsWith("jsdoc-forms.ts"), d.file);
});

test("external @throws (lib.d.ts, @types) propagate unless ignoreExternal", () => {
  const withExternal = analyzeFiles([fixture("external.ts")]);
  const parses = errorsFor(withExternal, "parses");
  assert.equal(parses.length, 1);
  assert.deepEqual(parses[0]?.types, ["SyntaxError"]);
  const site = parses[0]?.sites?.[0];
  assert.equal(site?.kind, "call");
  assert.equal(site?.callee?.name, "JSON.parse");
  assert.equal(site?.callee?.external, true);
  assert.match(site?.callee?.file ?? "", /lib\.es5\.d\.ts$/);

  const withoutExternal = analyzeFiles([fixture("external.ts")], { ignoreExternal: true });
  assert.equal(errorsFor(withoutExternal, "parses").length, 0);
  assert.equal(errorsFor(withoutExternal, "local").length, 1);
});

test("missing-throws diagnostics list every throw site", () => {
  const diagnostics = analyzeFiles([fixture("basic.ts")]);

  const direct = errorsFor(diagnostics, "missingTag")[0];
  assert.ok(direct?.sites !== undefined);
  assert.equal(direct.sites.length, 1);
  assert.equal(direct.sites[0]?.kind, "throw");
  assert.equal(direct.sites[0]?.type, "ValidationError");
  assert.match(direct.sites[0]?.text ?? "", /^throw new ValidationError/);
  assert.ok(direct.sites[0]!.line > direct.line);

  const propagated = errorsFor(diagnostics, "callsDocumented")[0];
  const callSite = propagated?.sites?.find((s) => s.kind === "call");
  assert.ok(callSite !== undefined);
  assert.equal(callSite.type, "NotFoundError");
  assert.equal(callSite.callee?.external, false);
  assert.ok(callSite.callee?.file.endsWith("basic.ts"));
  assert.ok((callSite.callee?.line ?? 0) > 0);
});

test("analyzeProject reports only the project's own files and tolerates config warnings", () => {
  const workDir = mkdtempSync(path.join(tmpdir(), "throwscript-project-"));
  try {
    writeFileSync(
      path.join(workDir, "a.ts"),
      [
        'import { helper } from "./b";',
        "export function own(): void {",
        '  throw new Error("a");',
        "}",
        "export function usesHelper(): number {",
        "  return helper();",
        "}",
        "",
      ].join("\n"),
    );
    writeFileSync(
      path.join(workDir, "b.ts"),
      [
        "export function helper(): number {",
        '  throw new Error("b");',
        "}",
        "",
      ].join("\n"),
    );
    writeFileSync(
      path.join(workDir, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: { strict: true, lib: ["es2022", "es2099.imaginary"] },
        files: ["a.ts"],
      }),
    );

    const warnings: string[] = [];
    const diagnostics = analyzeProject(path.join(workDir, "tsconfig.json"), {
      onConfigWarning: (m) => warnings.push(m),
    });
    assert.equal(warnings.length, 1);
    assert.match(warnings[0] ?? "", /--lib/);

    assert.equal(diagnostics.length, 1);
    assert.ok(diagnostics[0]?.file.endsWith("a.ts"));
    assert.equal(diagnostics[0]?.functionName, "'own'");
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});

test("formatReport renders a markdown report with sites and callees", () => {
  const diagnostics = [
    ...analyzeFiles([fixture("external.ts")]),
    ...analyzeFiles([fixture("basic.ts")]),
  ];
  const report = formatReport(diagnostics, fixturesDir);

  assert.match(report, /^# throwscript report\n/);
  assert.match(report, /## Missing `@throws`/);
  assert.match(report, /## Unused `@throws`/);
  // File headings are relative to cwd.
  assert.match(report, /^### external\.ts$/m);
  assert.match(report, /^### basic\.ts$/m);
  assert.match(report, /\*\*'parses'\*\* \(line 1\) — add `@throws \{SyntaxError\}`/);
  assert.match(
    report,
    /propagates `SyntaxError` via `JSON\.parse` \(.*lib\.es5\.d\.ts:\d+\) \*\(external\)\* — `JSON\.parse\(text\)`/,
  );
  assert.match(report, /throws `ValidationError` — `throw new ValidationError/);
  assert.match(report, /\*\*'overDocumented'\*\* \(line \d+\) — `@throws \{ValidationError\}` is never observed to throw/);

  assert.match(formatReport([]), /No problems found/);
});

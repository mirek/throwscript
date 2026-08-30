import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { ESLint, type Linter } from "eslint";
import tsParser from "@typescript-eslint/parser";
import plugin from "../src/index.js";

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");

function createESLint(options: { fix?: boolean } = {}): ESLint {
  const config: Linter.Config[] = [
    plugin.configs.recommended,
    {
      files: ["**/*.ts"],
      languageOptions: {
        parser: tsParser,
        parserOptions: { project: "./tsconfig.json", tsconfigRootDir: fixturesDir },
      },
    },
  ];
  return new ESLint({
    cwd: fixturesDir,
    overrideConfigFile: true,
    overrideConfig: config,
    fix: options.fix ?? false,
  });
}

test("recommended config reports missing and unused @throws through ESLint", async () => {
  const [result] = await createESLint().lintFiles(["errors.ts"]);
  assert.ok(result !== undefined);
  const messages = result.messages.map((m) => ({
    ruleId: m.ruleId,
    severity: m.severity,
    line: m.line,
    message: m.message,
  }));
  assert.deepEqual(messages, [
    {
      ruleId: "throwscript/missing-throws",
      severity: 2,
      line: 10,
      message:
        "'undocumented' can throw {BoomError} but has no @throws tag for it. " +
        "Document with `@throws {BoomError}`.",
    },
    {
      ruleId: "throwscript/missing-throws",
      severity: 2,
      line: 14,
      message:
        "'propagates' can throw {BoomError} but has no @throws tag for it. " +
        "Document with `@throws {BoomError}`.",
    },
    {
      ruleId: "throwscript/missing-throws",
      severity: 2,
      line: 22,
      message:
        "'parses' can throw {SyntaxError} but has no @throws tag for it. " +
        "Document with `@throws {SyntaxError}`.",
    },
    {
      ruleId: "throwscript/unused-throws",
      severity: 1,
      line: 27,
      message: "'stale' documents @throws {BoomError} but nothing observable throws it.",
    },
  ]);
  assert.equal(result.fixableErrorCount, 3);
});

test("works with parserOptions.projectService", async () => {
  const eslint = new ESLint({
    cwd: fixturesDir,
    overrideConfigFile: true,
    overrideConfig: [
      plugin.configs.recommended,
      {
        files: ["**/*.ts"],
        languageOptions: {
          parser: tsParser,
          parserOptions: { projectService: true, tsconfigRootDir: fixturesDir },
        },
      },
    ],
  });
  const [result] = await eslint.lintFiles(["errors.ts"]);
  assert.deepEqual(
    result?.messages.map((m) => [m.ruleId, m.line]),
    [
      ["throwscript/missing-throws", 10],
      ["throwscript/missing-throws", 14],
      ["throwscript/missing-throws", 22],
      ["throwscript/unused-throws", 27],
    ],
  );
});

test("a clean file produces no messages", async () => {
  const [result] = await createESLint().lintFiles(["clean.ts"]);
  assert.deepEqual(result?.messages, []);
});

test("ignoreExternal drops @throws documented in .d.ts files", async () => {
  const eslint = new ESLint({
    cwd: fixturesDir,
    overrideConfigFile: true,
    overrideConfig: [
      {
        files: ["**/*.ts"],
        plugins: { throwscript: plugin },
        languageOptions: {
          parser: tsParser,
          parserOptions: { project: "./tsconfig.json", tsconfigRootDir: fixturesDir },
        },
        rules: { "throwscript/missing-throws": ["error", { ignoreExternal: true }] },
      },
    ],
  });
  const [result] = await eslint.lintFiles(["errors.ts"]);
  const names = result?.messages.map((m) => m.message.match(/^'(\w+)'/)?.[1]);
  assert.deepEqual(names, ["undocumented", "propagates"]);
});

test("--fix inserts the missing @throws tags", async () => {
  const [result] = await createESLint({ fix: true }).lintFiles(["errors.ts"]);
  assert.ok(result?.output !== undefined);
  assert.match(
    result.output,
    /\/\*\*\n \* @throws \{BoomError\}\n \*\/\nexport function undocumented\(\)/,
  );
  assert.match(
    result.output,
    /\/\*\*\n \* @throws \{SyntaxError\}\n \*\/\nexport function parses\(/,
  );
  // Only the unused-tag warning is left: it has no fix.
  assert.deepEqual(
    result.messages.map((m) => m.ruleId),
    ["throwscript/unused-throws"],
  );
});

test("plugin exposes its meta and rules", () => {
  assert.equal(plugin.meta.name, "@mirek/eslint-plugin-throwscript");
  assert.match(plugin.meta.version, /^\d+\.\d+\.\d+/);
  assert.deepEqual(Object.keys(plugin.rules).toSorted(), ["missing-throws", "unused-throws"]);
});

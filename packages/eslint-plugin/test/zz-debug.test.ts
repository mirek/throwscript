import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { ESLint, type Linter, type Rule } from "eslint";
import tsParser from "@typescript-eslint/parser";
import ts from "typescript";
import plugin from "../src/index.js";

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const errorsFile = path.join(fixturesDir, "errors.ts");
let previousSourceFile: ts.SourceFile | undefined;
let previousLib: ts.SourceFile | undefined;

const debugRule: Rule.RuleModule = {
  meta: { type: "problem", schema: [] },
  create(context) {
    return {
      Program() {
        const services = context.sourceCode.parserServices as any;
        const program: ts.Program = services.program;
        const checker = program.getTypeChecker();
        const sf: ts.SourceFile = services.esTreeNodeToTSNodeMap.get(context.sourceCode.ast);
        let call: ts.CallExpression | undefined;
        const visit = (n: ts.Node) => {
          if (ts.isCallExpression(n) && n.expression.getText(sf) === "JSON.parse") call = n;
          ts.forEachChild(n, visit);
        };
        visit(sf);
        const decl = call && checker.getResolvedSignature(call)?.getDeclaration();
        const lib = decl?.getSourceFile();
        console.error("[debug]", JSON.stringify({
          file: path.basename(sf.fileName),
          sameSourceFile: sf === previousSourceFile,
          sameLib: lib === previousLib,
          libFile: lib?.fileName,
          libHasThrowsText: lib?.text.includes("@throws {SyntaxError}"),
          tags: decl ? ts.getJSDocTags(decl).map((t) => t.tagName.text) : null,
          jsDocLen: (decl as any)?.jsDoc?.length,
          declKind: decl && ts.SyntaxKind[decl.kind],
          declText: decl?.getText(lib).slice(0, 60),
          libIsDeclaration: lib?.isDeclarationFile,
          libFromExternal: lib && program.isSourceFileFromExternalLibrary(lib),
          libIsDefault: lib && program.isSourceFileDefaultLibrary(lib),
          jsDocParsingMode: (program as any).getCompilerOptions?.()?.jsDocParsingMode,
        }));
        previousSourceFile = sf;
        previousLib = lib;
      },
    };
  },
};

function createESLint(ignoreExternal: boolean): ESLint {
  const config: Linter.Config[] = [
    {
      files: ["**/*.ts"],
      plugins: { throwscript: plugin, dbg: { rules: { probe: debugRule } } },
      languageOptions: {
        parser: tsParser,
        parserOptions: { project: "./tsconfig.json", tsconfigRootDir: fixturesDir },
      },
      rules: {
        "throwscript/missing-throws": ["error", { ignoreExternal }],
        "dbg/probe": "error",
      },
    },
  ];
  return new ESLint({ cwd: fixturesDir, overrideConfigFile: true, overrideConfig: config });
}

test("debug sequence", async () => {
  console.error("[debug] env", JSON.stringify({ CI: process.env.CI, node: process.version, ts: ts.version, cpus: (await import("node:os")).availableParallelism() }));
  const text = readFileSync(errorsFile, "utf8");
  const names = (r: ESLint.LintResult | undefined) =>
    r?.messages.map((m) => m.message.match(/^'(\w+)'/)?.[1]).filter(Boolean);
  const steps: Array<[string, () => Promise<ESLint.LintResult[]>]> = [
    ["files false #1", () => createESLint(false).lintFiles(["errors.ts"])],
    ["files true", () => createESLint(true).lintFiles(["errors.ts"])],
    ["files false #2", () => createESLint(false).lintFiles(["errors.ts"])],
    ["text modified false", () => createESLint(false).lintText(text + "\n// changed\n", { filePath: errorsFile })],
    ["files false #3", () => createESLint(false).lintFiles(["errors.ts"])],
    ["text modified2 false", () => createESLint(false).lintText(text + "\n// changed again\n", { filePath: errorsFile })],
    ["text original false", () => createESLint(false).lintText(text, { filePath: errorsFile })],
  ];
  for (const [label, run] of steps) {
    const [r] = await run();
    console.error("[debug] step", label, JSON.stringify(names(r)));
  }
});

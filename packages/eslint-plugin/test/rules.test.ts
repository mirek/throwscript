import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { RuleTester } from "eslint";
import tsParser from "@typescript-eslint/parser";
import { rules } from "../src/index.js";

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const filename = path.join(fixturesDir, "file.ts");

RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

const ruleTester = new RuleTester({
  languageOptions: {
    parser: tsParser,
    parserOptions: {
      project: "./tsconfig.json",
      tsconfigRootDir: fixturesDir,
    },
  },
});

ruleTester.run("missing-throws", rules["missing-throws"], {
  valid: [
    {
      filename,
      code: `
        /** @throws {RangeError} when negative */
        export function f(n: number): number {
          if (n < 0) throw new RangeError("negative");
          return n;
        }
      `,
    },
    {
      filename,
      code: `
        export function f(): void {
          throw new Error("guard"); // @nothrow
        }
      `,
    },
    {
      filename,
      code: `
        export function f(): void {
          try { throw new Error("x"); } catch { /* handled */ }
        }
      `,
    },
    {
      filename,
      options: [{ ignoreExternal: true }],
      code: `
        export function parse(text: string): unknown {
          return JSON.parse(text);
        }
      `,
    },
  ],
  invalid: [
    {
      filename,
      code: `
        export function f(): void {
          throw new Error("x");
        }
      `,
      errors: [
        {
          messageId: "missingThrows",
          data: {
            message:
              "'f' can throw {Error} but has no @throws tag for it. Document with `@throws {Error}`.",
          },
          line: 2,
          column: 25,
          endColumn: 26,
        },
      ],
      output: `
        /**
         * @throws {Error}
         */
        export function f(): void {
          throw new Error("x");
        }
      `,
    },
    {
      filename,
      code: `
        /** Rejects on failure. */
        export async function f(): Promise<void> {
          throw new TypeError("x");
        }
      `,
      errors: [{ messageId: "missingThrows", line: 3 }],
      output: `
        /**
         * Rejects on failure.
         * @throws {TypeError}
         */
        export async function f(): Promise<void> {
          throw new TypeError("x");
        }
      `,
    },
    {
      filename,
      code: `
        export function parse(text: string): unknown {
          return JSON.parse(text);
        }
      `,
      errors: [{ messageId: "missingThrows", line: 2 }],
      output: `
        /**
         * @throws {SyntaxError}
         */
        export function parse(text: string): unknown {
          return JSON.parse(text);
        }
      `,
    },
  ],
});

ruleTester.run("unused-throws", rules["unused-throws"], {
  valid: [
    {
      filename,
      code: `
        /** @throws {RangeError} when negative */
        export function f(n: number): number {
          if (n < 0) throw new RangeError("negative");
          return n;
        }
      `,
    },
    {
      filename,
      code: `
        /**
         * @throws {RangeError} documented for callers // @nothrow-line
         */
        export function f(): number {
          return 1;
        }
      `,
    },
  ],
  invalid: [
    {
      filename,
      code: `
        /**
         * @throws {RangeError} never thrown
         */
        export function f(): number {
          return 1;
        }
      `,
      errors: [
        {
          messageId: "unusedThrows",
          data: {
            message: "'f' documents @throws {RangeError} but nothing observable throws it.",
          },
          line: 3,
          column: 12,
          endColumn: 19,
        },
      ],
    },
  ],
});

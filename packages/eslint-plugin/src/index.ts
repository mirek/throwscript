import { createRequire } from "node:module";
import type { ESLint, Linter } from "eslint";
import missingThrows from "./rules/missing-throws.js";
import unusedThrows from "./rules/unused-throws.js";

const VERSION = (createRequire(import.meta.url)("../package.json") as { version: string }).version;

export const rules = {
  "missing-throws": missingThrows,
  "unused-throws": unusedThrows,
};

const plugin = {
  meta: {
    name: "@mirek/eslint-plugin-throwscript",
    version: VERSION,
  },
  rules,
  configs: {} as {
    /** Flat config: `missing-throws` as an error, `unused-throws` as a warning. */
    recommended: Linter.Config;
  },
} satisfies ESLint.Plugin;

plugin.configs.recommended = {
  name: "throwscript/recommended",
  plugins: { throwscript: plugin },
  rules: {
    "throwscript/missing-throws": "error",
    "throwscript/unused-throws": "warn",
  },
};

export const configs = plugin.configs;
export default plugin;

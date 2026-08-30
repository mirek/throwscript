# @mirek/eslint-plugin-throwscript

ESLint rules asserting **every function that can throw has a JSDoc `@throws`
tag with the appropriate error type** — the [throwscript](https://github.com/mirek/throwscript)
analyzer as an ESLint plugin, so the diagnostics show up in your editor, run
with the rest of your lint, and `eslint --fix` inserts the missing tags.

```ts
// ✗ throwscript/missing-throws: 'loadUser' can throw {NotFoundError} but has no @throws tag
export function loadUser(id: string): User {
  const user = db.get(id);
  if (!user) throw new NotFoundError(id);
  return user;
}

// ✓ ok
/**
 * @throws {NotFoundError} when the id does not exist
 */
export function loadUser(id: string): User {
  const user = db.get(id);
  if (!user) throw new NotFoundError(id);
  return user;
}
```

## Setup

The rules need type information, so the file must be parsed by
`@typescript-eslint/parser` with
[typed linting](https://typescript-eslint.io/getting-started/typed-linting)
enabled (`parserOptions.projectService` or `parserOptions.project`).

```sh
pnpm add -D @mirek/eslint-plugin-throwscript @typescript-eslint/parser eslint typescript
```

```js
// eslint.config.js
import throwscript from "@mirek/eslint-plugin-throwscript";
import tsParser from "@typescript-eslint/parser";

export default [
  throwscript.configs.recommended,
  {
    files: ["**/*.ts", "**/*.tsx", "**/*.mts", "**/*.cts"],
    languageOptions: {
      parser: tsParser,
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
  },
];
```

If you already use `typescript-eslint`, add the plugin's config next to yours:

```js
import tseslint from "typescript-eslint";
import throwscript from "@mirek/eslint-plugin-throwscript";

export default tseslint.config(
  tseslint.configs.recommendedTypeChecked,
  throwscript.configs.recommended,
  { languageOptions: { parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname } } },
);
```

`configs.recommended` enables `throwscript/missing-throws` as an error and
`throwscript/unused-throws` as a warning for `**/*.{ts,tsx,mts,cts}` — keep
the typed parser configured for those same files, as above. To pick
severities, options, or files yourself, register the plugin and set the rules
directly — keep them scoped to files the typed parser handles, since a file
parsed without type information makes the rules throw:

```js
export default [
  {
    files: ["**/*.ts", "**/*.tsx", "**/*.mts", "**/*.cts"],
    plugins: { throwscript },
    rules: {
      "throwscript/missing-throws": ["error", { ignoreExternal: true }],
      "throwscript/unused-throws": "off",
    },
  },
];
```

The package is ESM only; it requires ESLint 9 or newer (flat config).

Prefer `projectService` over the legacy `project` option. With `project`,
typescript-eslint builds the program once per process when it detects a
one-shot run (`CI=true` or the `eslint` binary), and a *second* parse of the
same file — the ESLint API linting a file twice, or `RuleTester` re-linting a
fix's output — falls back to an isolated program with no type information, so
cross-file and lib `@throws` are silently missed. The `eslint` CLI parses each
file once (and `--fix` disables the one-shot mode), so it is unaffected; for
programmatic use set `parserOptions.disallowAutomaticSingleRunInference: true`.

## Rules

Both rules accept one options object:

| Option | Default | Meaning |
| --- | --- | --- |
| `ignoreExternal` | `false` | Ignore `@throws` documented in `.d.ts` files (the TypeScript lib, `@types/node`, `node_modules`). By default calling `JSON.parse` propagates its documented `SyntaxError` into the caller. |

### `throwscript/missing-throws` 🔧

Reports every function, method, constructor, accessor, or arrow function that
can throw — or reject, for `async` / Promise-returning functions — an error
type its JSDoc does not document with `@throws`. Reported on the function
name.

Auto-fixable: `eslint --fix` appends `* @throws {Type}` lines to the existing
JSDoc block, or creates a block above the declaration. Fixes are skipped for
declarations that do not start their own line (inline callbacks), where a
JSDoc block cannot be attached unambiguously. Documenting a callee can make
its callers' tags incomplete in turn, so a call chain may need `--fix` run
more than once.

### `throwscript/unused-throws`

Reports a `@throws {Type}` tag for which nothing observable in the function
body throws `Type`. Such a tag is either stale (delete it) or documents a throw
the checker cannot see — for example from an undocumented callee, in which
case document the callee. Reported on the tag.

## Muting

Standard ESLint disable comments work as usual:

```ts
// eslint-disable-next-line throwscript/missing-throws
export function assertNever(x: never): never {
  throw new Error(`unexpected ${x}`);
}
```

The analyzer's own `@nothrow` directives work too and are more targeted: a
muted throw site is not counted at all, so it neither needs documenting nor
counts toward a documented tag being "used", and the same source checks
identically under the `throwscript` CLI:

```ts
throw new CacheMissError(key); // @nothrow           — mutes this line (and the next)
throw new CacheMissError(key); // @nothrow-line      — only this line
// @nothrow-next-line                                — only the following line
throw new CacheMissError(key);
```

## What counts as "can throw"

See the [throwscript README](https://github.com/mirek/throwscript#what-counts-as-can-throw)
for the full table: `throw` statements, `Promise.reject`, calls to
`@throws`-documented functions (including `.d.ts` ones such as `JSON.parse`),
awaited or returned promises from documented functions, rethrows in `catch`
blocks; `try`/`catch` and `.catch(...)` swallow. A documented type covers a
thrown type when the names match or the thrown type is assignable to it, so
`@throws {Error}` covers every `Error` subclass.

## Related

- [`@mirek/throwscript-cli`](https://github.com/mirek/throwscript/tree/main/packages/cli) —
  the standalone `throwscript` command, with `--fix` that iterates to a fixed
  point and a Markdown report mode for reviewers and LLMs.
- [`@mirek/throwscript-core`](https://github.com/mirek/throwscript/tree/main/packages/core) —
  the analyzer both of these are built on.

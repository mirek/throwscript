# throwscript

A linter-like checker that asserts **every function that can throw has a JSDoc
`@throws` tag with the appropriate error type**.

Built on the TypeScript compiler API. Promise-returning functions are handled
implicitly: a rejection is treated exactly like a throw and is annotated the
same way as in synchronous code.

```ts
// ✗ error: 'loadUser' can throw {NotFoundError} but has no @throws tag
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

// ✓ ok — async rejection, annotated the same way as a sync throw
/**
 * @throws {NetworkError} when the request fails
 */
export async function fetchUser(id: string): Promise<User> {
  const res = await fetch(`/users/${id}`);
  if (!res.ok) throw new NetworkError(res.statusText);
  return res.json();
}
```

## Usage

```sh
# check every file in the tsconfig.json project in the current directory
throwscript

# check a specific project
throwscript --project path/to/tsconfig.json

# check individual files
throwscript src/a.ts src/b.ts

# automatically insert the missing @throws tags
throwscript --fix src/a.ts

# machine-readable output
throwscript --json src/a.ts
```

Exit code is `1` when any function is missing a `@throws` tag, `0` otherwise.
Unused `@throws` tags are reported as warnings (disable with `--no-unused`).

## Muting with `@nothrow`

Like eslint's disable comments, individual lines can be muted:

```ts
throw new CacheMissError(key); // @nothrow          — mutes this line
throw new CacheMissError(key); // @nothrow-line     — same thing, explicit

// @nothrow-next-line
throw new CacheMissError(key); //                   — muted by the line above
```

What a muted line means depends on what is on it:

- a `throw`, a propagating call, or a `Promise.reject` — that throw site is
  ignored (it no longer needs documenting, and no longer counts toward a
  documented tag being "used")
- the function declaration itself (put `// @nothrow-next-line` directly above
  the declaration, below any JSDoc) — the whole function's missing-`@throws`
  report is muted
- a `@throws` tag line inside a JSDoc block — the unused-tag warning for that
  tag is muted

The directives work in `//` and `/* */` comments; inside a multi-line comment
a directive applies relative to the line it is written on.

## Autofix

`throwscript --fix` inserts the missing tags and then re-checks:

- a function with an existing JSDoc block gets `* @throws {Type}` lines
  appended before the closing `*/` (single-line `/** ... */` blocks are broken
  open)
- a function without JSDoc gets a fresh block above the declaration — for
  arrow functions assigned to a variable, above the variable statement —
  matching the surrounding indentation

Only missing-`@throws` errors are auto-fixed; unused-tag warnings are left for
a human to judge. Fixes are skipped for declarations that do not start their
own line (e.g. inline callbacks), where a JSDoc block cannot be attached
unambiguously.

## What counts as "can throw"

| Construct | Behaviour |
| --- | --- |
| `throw new SomeError()` | must be documented as `@throws {SomeError}` |
| `throw` inside `async` function | rejects the promise — documented the same way |
| `return Promise.reject(new E())` | must be documented as `@throws {E}` |
| calling a function documented with `@throws {E}` | propagates `E` to the caller |
| `await`ing / returning a promise from a `@throws`-documented function | propagates `E` to the caller |
| fire-and-forget promise call (not awaited/returned) | does **not** propagate (it becomes an unhandled rejection, not a throw here) |
| throw inside `try` with a `catch` clause | swallowed — nothing to document |
| `throw error` rethrow in a `catch` block | propagates everything the `try` block could throw (or the `instanceof`-narrowed type) |
| `foo().catch(...)` / `try { await foo() } catch` | rejection handled locally — nothing to document |

A documented type covers a thrown type when the names match **or** the thrown
type is assignable to it, so `@throws {Error}` covers `@throws {ValidationError}`
subclasses.

## Monorepo layout

| Package | Description |
| --- | --- |
| [`@throwscript/core`](packages/core) | The analyzer: walks a `ts.Program` and returns structured diagnostics |
| [`throwscript`](packages/cli) | The CLI wrapper |

## Development

```sh
pnpm install
pnpm run build   # tsc project references build
pnpm run lint    # oxlint
pnpm run test    # node:test via tsx (builds first)
pnpm run check   # build + lint + test
```

## API

```ts
import { analyzeFiles, analyzeProject, formatDiagnostic } from "@throwscript/core";

const diagnostics = analyzeProject("tsconfig.json");
for (const d of diagnostics) {
  console.log(formatDiagnostic(d, process.cwd()));
}
```

Each diagnostic carries `kind` (`missing-throws` | `unused-throws`), `severity`,
`file`, `line`, `column`, `functionName`, the error `types` involved, a
human-readable `message`, and — for fixable problems — a `fix` text edit.
`applyFixes(diagnostics)` returns the patched file contents keyed by file name
for the caller to write to disk.

## Known limitations

- Rejections of promises stored in a variable and awaited later
  (`const p = f(); await p`) are not tracked.
- A throwing callback passed to another function (`arr.map(cb)`) is checked as
  its own function, but its error type is not propagated to the caller of
  `map`.
- `@throws` on overloads is read from the implementation signature that the
  checker resolves for the call.

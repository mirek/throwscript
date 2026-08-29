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
pnpm add -D @mirek/throwscript-cli   # installs the `throwscript` bin
# or run without installing: npx @mirek/throwscript-cli
```

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
throwscript --format json src/a.ts

# a Markdown report listing every throw site, for a reviewer or an LLM
throwscript --format markdown > throws-report.md

# ignore @throws documented in .d.ts files (JSON.parse, path.join, ...)
throwscript --no-external
```

Exit code is `1` when any function is missing a `@throws` tag, `0` otherwise.
Unused `@throws` tags are reported as warnings (disable with `--no-unused`).

Only files that belong to the project (or that were passed explicitly) are
reported on. Files that are merely imported — e.g. another workspace package
resolved through `paths` — are used to resolve `@throws` tags on callees but
produce no diagnostics of their own.

throwscript uses the `typescript` package installed in your project (any
5.5+ or 6.x release); tsconfig options this compiler does not understand are
printed as warnings and the analysis proceeds, as `tsc` would.

## Accepted `@throws` forms

```ts
/** @throws {NotFoundError} when the id does not exist */   // canonical
/** @throws {NotFoundError | TimeoutError} ... */             // union
/** @throws {@link NotFoundError} when ... */                 // TSDoc inline link
/** @throws NotFoundError when ... */                         // bare type name
/** @throws when the id does not exist */                     // no type: documents `Error`
```

A tag without a recognizable type documents the base `Error`, which covers
every `Error` subclass. Type names are compared without their namespace
qualifier, so `@throws {JsonRpcError}` covers `throw new Jsonrpc.JsonRpcError()`.

## Muting with `@nothrow`

Like eslint's disable comments, individual lines can be muted:

```ts
throw new CacheMissError(key); // @nothrow — mutes this line (and the next)

// @nothrow — works on its own line above the statement too
throw new CacheMissError(key);

throw new CacheMissError(key); // @nothrow-line — explicit: only this line

// @nothrow-next-line — explicit: only the following line
throw new CacheMissError(key);
```

The bare `@nothrow` covers both its own line and the next, so it works
trailing a statement or on its own line above one. Use the explicit `-line` /
`-next-line` forms when a bare directive would spill onto a neighbouring line
you want checked.

What a muted line means depends on what is on it:

- a `throw`, a propagating call, or a `Promise.reject` — that throw site is
  ignored (it no longer needs documenting, and no longer counts toward a
  documented tag being "used")
- the function declaration itself (put `// @nothrow` or `// @nothrow-next-line`
  directly above the declaration, below any JSDoc) — the whole function's
  missing-`@throws` report is muted
- a `@throws` tag line inside a JSDoc block — the unused-tag warning for that
  tag is muted

The directives work in `//` and `/* */` comments; inside a multi-line comment
a directive applies relative to the line it is written on.

## Autofix

`throwscript --fix` inserts the missing tags and re-checks, repeating until
nothing fixable remains — documenting a callee makes its callers' tags
incomplete in turn, so a call chain converges over a few rounds:

- a function with an existing JSDoc block gets `* @throws {Type}` lines
  appended before the closing `*/` (a single-line `/** desc */` is rebuilt as
  a block with the description on its own line)
- a function without JSDoc gets a fresh block above the declaration — for
  arrow functions assigned to a variable, above the variable statement —
  matching the surrounding indentation

Only missing-`@throws` errors are auto-fixed; unused-tag warnings are left for
a human to judge. Fixes are skipped for declarations that do not start their
own line (e.g. inline callbacks), where a JSDoc block cannot be attached
unambiguously.

## Using the report with an LLM or a reviewer

throwscript deliberately does not decide *how* a problem should be resolved:
whether a throw is part of a function's contract (document it), an
implementation detail the caller should never see (handle it), or a
programmer-error guard (mute it) is a judgment call. `--format markdown`
produces a self-contained report for whoever makes that call, human or model:

```markdown
## Missing `@throws`

### packages/fs/src/read-json.ts

- **'readJson'** (line 5) — add `@throws {SyntaxError}`
  - line 6: propagates `SyntaxError` via `JSON.parse` (…/lib.es5.d.ts:1163) *(external)* — `JSON.parse(text)`

### packages/rb-tree/src/map.ts

- **'get'** (line 28) — add `@throws {Error}`
  - line 31: throws `Error` — `throw new Error(`Key ${inspect(key)} not found.`)`
```

A workable loop for an agent:

1. `throwscript --format markdown > report.md` and hand it over.
2. For each function, the agent either edits the code so it no longer throws,
   writes a `@throws {Type} when …` tag, or appends `// @nothrow` to a
   deliberate guard.
3. `throwscript` again — the remaining errors are the ones it left for
   `--fix`, which inserts bare tags and repeats until callers of newly
   documented functions are documented too.

The same information is available programmatically: every `missing-throws`
diagnostic carries `sites`, one entry per throw site with its `kind`
(`throw` / `rethrow` / `call` / `reject`), source text, and — for propagated
throws — the documented `callee` and where it is declared.

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
| calling a `.d.ts`-documented function (`JSON.parse`, `fs.readFileSync`, …) | propagates its documented type; opt out with `--no-external` |

A documented type covers a thrown type when the names match **or** the thrown
type is assignable to it, so `@throws {Error}` covers `@throws {ValidationError}`
subclasses.

## Monorepo layout

| Package | Description |
| --- | --- |
| [`@mirek/throwscript-core`](packages/core) | The analyzer: walks a `ts.Program` and returns structured diagnostics |
| [`@mirek/throwscript-cli`](packages/cli) | The `throwscript` command-line tool |

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
import {
  analyzeFiles,
  analyzeProject,
  formatDiagnostic,
  formatReport,
} from "@mirek/throwscript-core";

const diagnostics = analyzeProject("tsconfig.json", {
  ignoreExternal: true,
  onConfigWarning: (message) => console.warn(message),
});
for (const d of diagnostics) {
  console.log(formatDiagnostic(d, process.cwd()));
}
console.log(formatReport(diagnostics, process.cwd())); // Markdown
```

Each diagnostic carries `kind` (`missing-throws` | `unused-throws`), `severity`,
`file`, `line`, `column`, `functionName`, the error `types` involved, a
human-readable `message`, the throw `sites` (for `missing-throws`), and — for
fixable problems — a `fix` text edit. `applyFixes(diagnostics)` returns the
patched file contents keyed by file name for the caller to write to disk.

Options: `reportUnused` (default `true`), `ignoreExternal` (default `false`),
`fileFilter` (defaults to the project's / the given files), `onConfigWarning`.

## Known limitations

- Rejections of promises stored in a variable and awaited later
  (`const p = f(); await p`) are not tracked.
- A throwing callback passed to another function (`arr.map(cb)`) is checked as
  its own function, but its error type is not propagated to the caller of
  `map`.
- `@throws` on overloads is read from the implementation signature that the
  checker resolves for the call.

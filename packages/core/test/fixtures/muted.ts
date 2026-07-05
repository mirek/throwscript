export class MutedError extends Error {}
export class OtherError extends Error {}

// GOOD: bare @nothrow trailing the throw line mutes it.
export function mutedSameLine(): void {
  throw new MutedError("x"); // @nothrow
}

// GOOD: explicit -line variant.
export function mutedLineSuffix(): void {
  throw new MutedError("x"); // @nothrow-line
}

// GOOD: -next-line variant above the throw.
export function mutedNextLine(): void {
  // @nothrow-next-line
  throw new MutedError("x");
}

// GOOD: -next-line above the declaration mutes the whole function's report.
// @nothrow-next-line
export function mutedFunction(): void {
  throw new MutedError("x");
}

// GOOD: bare @nothrow also covers the next line, so it works on its own line
// above the throw.
export function mutedAboveLine(): void {
  // @nothrow
  throw new MutedError("x");
}

// BAD: the explicit -line variant only mutes its own line; the throw on the
// next line is still reported.
export function notMuted(): void {
  // @nothrow-line
  throw new MutedError("x");
}

// BAD: the explicit -next-line variant does not mute its own line; a throw
// trailing it is still reported.
export function notMutedTrailing(): void {
  throw new MutedError("x"); // @nothrow-next-line
}

// BAD: muting one throw does not mute the others. Note the explicit -line
// form: a bare @nothrow here would spill onto the next line and mute the
// OtherError throw too.
export function partiallyMuted(kind: number): void {
  if (kind === 1) throw new MutedError("muted"); // @nothrow-line
  throw new OtherError("reported");
}

/**
 * @throws {MutedError}
 */
export function documentedThrower(): void {
  throw new MutedError("boom");
}

// GOOD: muted call — the callee's documented error does not propagate.
export function mutedCall(): void {
  documentedThrower(); // @nothrow
}

// GOOD: unused @throws warning muted with a directive on the tag's line.
/**
 * @throws {MutedError} kept for API compatibility @nothrow-line
 */
export function overDocumentedMuted(a: number): number {
  return a;
}

// WARNING: control case — same shape without the directive still warns.
/**
 * @throws {MutedError} legacy claim
 */
export function overDocumentedReported(a: number): number {
  return a;
}

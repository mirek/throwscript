export class NotFoundError extends Error {}
export class ValidationError extends Error {}
export class TimeoutError extends Error {}

// BAD: throws but has no @throws tag.
export function missingTag(id: string): string {
  if (id === "") {
    throw new ValidationError("empty id");
  }
  return id;
}

// GOOD: documented.
/**
 * Look up a record.
 * @throws {NotFoundError} when the id does not exist
 */
export function documented(id: string): string {
  if (id === "nope") {
    throw new NotFoundError(id);
  }
  return id;
}

// GOOD: documents a base class that covers the subclass throw.
/**
 * @throws {Error} on any failure
 */
export function documentedViaBaseClass(): void {
  throw new ValidationError("still an Error");
}

// BAD: documents one type but throws a second, undocumented one.
/**
 * @throws {NotFoundError}
 */
export function partiallyDocumented(kind: number): void {
  if (kind === 1) throw new NotFoundError("x");
  throw new TimeoutError("y");
}

// GOOD: cannot throw, needs no tag.
export function safe(a: number, b: number): number {
  return a + b;
}

// GOOD: throw is swallowed by catch, nothing escapes.
export function swallowed(): number {
  try {
    throw new ValidationError("contained");
  } catch {
    return -1;
  }
}

// BAD: rethrows the caught error, so the try block's throws escape.
export function rethrows(): number {
  try {
    throw new TimeoutError("escapes");
  } catch (error) {
    console.error(error);
    throw error;
  }
}

// BAD: calling a @throws-documented function propagates its error type.
export function callsDocumented(): string {
  return documented("nope");
}

// GOOD: caller documents the propagated type.
/**
 * @throws {NotFoundError}
 */
export function callsDocumentedAndDocuments(): string {
  return documented("nope");
}

// GOOD: caller catches the callee's documented error.
export function callsDocumentedAndCatches(): string {
  try {
    return documented("nope");
  } catch {
    return "fallback";
  }
}

// WARNING: documents an error type that is never thrown.
/**
 * @throws {ValidationError} never actually thrown
 */
export function overDocumented(a: number): number {
  return a * 2;
}

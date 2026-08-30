export class BoomError extends Error {}

/**
 * @throws {BoomError} when asked to
 */
export function documented(): void {
  throw new BoomError("boom");
}

export function undocumented(): void {
  throw new BoomError("boom");
}

export function propagates(): void {
  documented();
}

export function muted(): void {
  throw new BoomError("boom"); // @nothrow
}

export function parses(text: string): unknown {
  return JSON.parse(text);
}

/**
 * @throws {BoomError} never actually thrown
 */
export function stale(): number {
  return 1;
}

// eslint-disable-next-line throwscript/missing-throws
export function disabledByEslint(): void {
  throw new BoomError("boom");
}

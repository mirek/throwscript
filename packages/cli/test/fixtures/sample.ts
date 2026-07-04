export class BoomError extends Error {}

export function undocumented(): void {
  throw new BoomError("boom");
}

/**
 * @throws {BoomError} always
 */
export function documented(): void {
  throw new BoomError("boom");
}

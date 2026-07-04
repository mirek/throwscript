export class FixError extends Error {}
export class SecondError extends Error {}

export function noDoc(): void {
  throw new FixError("a");
}

/**
 * Existing multi-line docs.
 */
export function withDoc(): void {
  throw new FixError("b");
}

/** One-liner. */
export function oneLine(): void {
  throw new FixError("c");
}

export const arrow = (): void => {
  throw new FixError("d");
};

export class Box {
  method(): void {
    throw new FixError("e");
  }
}

export function twoTypes(kind: number): void {
  if (kind === 1) throw new FixError("f");
  throw new SecondError("g");
}

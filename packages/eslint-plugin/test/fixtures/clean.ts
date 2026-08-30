/**
 * @throws {RangeError} when n is negative
 */
export function checked(n: number): number {
  if (n < 0) throw new RangeError("negative");
  return n;
}

export function safe(n: number): number {
  try {
    return checked(n);
  } catch {
    return 0;
  }
}

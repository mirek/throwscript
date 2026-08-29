export class ChainError extends Error {}

export function leaf(): void {
  throw new ChainError("leaf");
}

export function mid(): void {
  leaf();
}

export function top(): void {
  mid();
}

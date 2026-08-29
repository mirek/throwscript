export function parses(text: string): unknown {
  return JSON.parse(text);
}

export function local(): void {
  throw new Error("local");
}

export class NetworkError extends Error {}
export class ParseError extends Error {}

// BAD: async function that throws rejects its promise; annotated like sync.
export async function fetchMissingTag(url: string): Promise<string> {
  if (!url.startsWith("https://")) {
    throw new NetworkError("insecure url");
  }
  return url;
}

// GOOD: async throw documented exactly like a sync one.
/**
 * @throws {NetworkError} when the url is not https
 */
export async function fetchDocumented(url: string): Promise<string> {
  if (!url.startsWith("https://")) {
    throw new NetworkError("insecure url");
  }
  return url;
}

// BAD: awaiting a @throws-documented async function propagates the rejection.
export async function awaitsDocumented(): Promise<string> {
  return await fetchDocumented("http://x");
}

// BAD: returning the promise without await still propagates the rejection.
export async function returnsPromiseDirectly(): Promise<string> {
  return fetchDocumented("http://x");
}

// GOOD: fire-and-forget call; the rejection never surfaces in this function.
export function fireAndForget(): void {
  void fetchDocumented("http://x");
}

// GOOD: rejection handled locally with .catch().
export async function handledWithCatch(): Promise<string> {
  return await fetchDocumented("http://x").catch(() => "fallback");
}

// GOOD: awaited call wrapped in try/catch.
export async function handledWithTry(): Promise<string> {
  try {
    return await fetchDocumented("http://x");
  } catch {
    return "fallback";
  }
}

// BAD: explicit Promise.reject that is returned.
export function rejectsExplicitly(flag: boolean): Promise<number> {
  if (flag) {
    return Promise.reject(new ParseError("bad input"));
  }
  return Promise.resolve(1);
}

// GOOD: documented explicit rejection.
/**
 * @throws {ParseError} when flag is set
 */
export function rejectsDocumented(flag: boolean): Promise<number> {
  if (flag) {
    return Promise.reject(new ParseError("bad input"));
  }
  return Promise.resolve(1);
}

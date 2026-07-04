export class ConfigError extends Error {}

// BAD: arrow functions are checked too.
export const parseConfig = (raw: string): string => {
  if (raw === "") {
    throw new ConfigError("empty");
  }
  return raw.trim();
};

// GOOD: JSDoc on the variable statement covers the arrow.
/**
 * @throws {ConfigError} when raw is empty
 */
export const parseConfigDocumented = (raw: string): string => {
  if (raw === "") {
    throw new ConfigError("empty");
  }
  return raw;
};

export class Store {
  private items = new Map<string, string>();

  // BAD: methods are checked.
  get(key: string): string {
    const value = this.items.get(key);
    if (value === undefined) {
      throw new ConfigError(`missing ${key}`);
    }
    return value;
  }

  // GOOD: documented method.
  /**
   * @throws {ConfigError} when key is missing
   */
  getDocumented(key: string): string {
    const value = this.items.get(key);
    if (value === undefined) {
      throw new ConfigError(`missing ${key}`);
    }
    return value;
  }

  // GOOD: no throw.
  has(key: string): boolean {
    return this.items.has(key);
  }
}

// BAD: union rethrow via instanceof narrowing still surfaces the type.
export function narrowedRethrow(): void {
  try {
    riskyInternal();
  } catch (error) {
    if (error instanceof ConfigError) {
      throw error;
    }
  }
}

/**
 * @throws {ConfigError}
 */
function riskyInternal(): void {
  throw new ConfigError("boom");
}

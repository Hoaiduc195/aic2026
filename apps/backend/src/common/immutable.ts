export function immutable<T extends object>(value: T): Readonly<T> {
  return Object.freeze(value);
}

export function immutableArray<T>(values: readonly T[]): readonly T[] {
  return Object.freeze([...values]);
}

/** Builds a value on first access and returns the same value thereafter. */
export function memoizeOnce<T>(build: () => T): () => T {
  let value: T;
  let built = false;
  return () => {
    if (!built) {
      value = build();
      built = true;
    }
    return value;
  };
}

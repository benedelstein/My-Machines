declare const runtimeBoundaryLeaseBrand: unique symbol;

/** Compile-time-only proof that the caller owns the session runtime boundary. */
export type RuntimeBoundaryLease = {
  readonly [runtimeBoundaryLeaseBrand]: true;
};

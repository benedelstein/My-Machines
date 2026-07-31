import type {
  RuntimeBoundaryLease,
  RuntimeBoundaryMutex,
} from "./runtime-boundary-mutex";
import type { SessionRuntimeBoundaryService } from "./session-runtime-boundary.service";

type Assert<Condition extends true> = Condition;
type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends
  (<Value>() => Value extends Right ? 1 : 2)
    ? true
    : false;

type ExclusiveOperation = Parameters<RuntimeBoundaryMutex["runExclusive"]>[0];

export type RuntimeBoundaryLeaseIsRequired = Assert<
  Equal<Parameters<ExclusiveOperation>, [RuntimeBoundaryLease]>
>;

export type RuntimeBoundaryLeaseCannotBeForgedFromEmptyObject = Assert<
  Equal<object extends RuntimeBoundaryLease ? true : false, false>
>;

export type ReadinessStagesAreNotPublic = Assert<
  Equal<"_ensureReady" extends keyof SessionRuntimeBoundaryService ? true : false, false>
>;

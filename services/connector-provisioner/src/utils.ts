import type { LogFields } from "@repo/shared";
import type { ConnectorProvisioningDurations } from "./connectors.schema";

/** Rounds stage timings to whole milliseconds for structured log fields. */
export function durationFields(durations: ConnectorProvisioningDurations): LogFields {
  return Object.fromEntries(
    Object.entries(durations)
      .filter((entry): entry is [string, number] => typeof entry[1] === "number")
      .map(([key, value]) => [key, Math.round(value)]),
  );
}

export function arraysEqual(left: string[], right: string[]): boolean {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}

export async function delay(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

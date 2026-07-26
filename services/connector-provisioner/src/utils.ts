import type { LogFields } from "@repo/shared";
import type { ConnectorProvisioningDurations } from "./types";

export async function hasValidBearer(request: Request, expectedToken: string): Promise<boolean> {
  const authorization = request.headers.get("Authorization");
  if (
    typeof expectedToken !== "string"
    || expectedToken.length === 0
    || authorization === null
    || !authorization.startsWith("Bearer ")
  ) {
    return false;
  }

  const providedToken = authorization.slice("Bearer ".length);
  const [providedDigest, expectedDigest] = await Promise.all([
    digest(providedToken),
    digest(expectedToken),
  ]);

  let difference = 0;
  for (let index = 0; index < providedDigest.length; index += 1) {
    difference |= (providedDigest[index] ?? 0) ^ (expectedDigest[index] ?? 0);
  }
  return difference === 0;
}

async function digest(value: string): Promise<Uint8Array> {
  const encoded = new TextEncoder().encode(value);
  return new Uint8Array(await crypto.subtle.digest("SHA-256", encoded));
}

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

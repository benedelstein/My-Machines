/**
 * Checks the request's Authorization header against the expected bearer
 * token(s) using a constant-time comparison, so response timing does not leak
 * how much of a token matched.
 *
 * @param request Incoming request, read for its `Authorization` header.
 * @param expectedTokens Provisioner bearer from the environment. May hold a
 *   comma-separated list so rotation can overlap old and new tokens instead of
 *   cutting over with a 401 window.
 * @returns True only when a `Bearer` header carries exactly one of the
 *   expected tokens.
 */
export async function hasValidBearer(request: Request, expectedTokens: string): Promise<boolean> {
  const authorization = request.headers.get("Authorization");
  const candidates = typeof expectedTokens === "string"
    ? expectedTokens.split(",").map((token) => token.trim()).filter((token) => token.length > 0)
    : [];
  if (
    candidates.length === 0
    || authorization === null
    || !authorization.startsWith("Bearer ")
  ) {
    return false;
  }

  const providedToken = authorization.slice("Bearer ".length);
  const providedDigest = await digest(providedToken);
  const comparisons = await Promise.all(candidates.map(async (candidate) => {
    return constantTimeEquals(providedDigest, await digest(candidate));
  }));
  return comparisons.some(Boolean);
}

// Hashing first gives both sides a fixed length, so the XOR loop below always
// runs the same number of iterations regardless of the provided token.
async function digest(value: string): Promise<Uint8Array> {
  const encoded = new TextEncoder().encode(value);
  return new Uint8Array(await crypto.subtle.digest("SHA-256", encoded));
}

// Constant-time equality: accumulates differences with XOR instead of
// returning at the first mismatched byte.
function constantTimeEquals(left: Uint8Array, right: Uint8Array): boolean {
  let difference = left.length ^ right.length;
  for (let index = 0; index < left.length; index += 1) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return difference === 0;
}

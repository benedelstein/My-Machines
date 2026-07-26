/**
 * Checks the request's Authorization header against the expected bearer token
 * using a constant-time comparison, so response timing does not leak how much
 * of the token matched.
 *
 * @param request Incoming request, read for its `Authorization` header.
 * @param expectedToken Provisioner bearer from the environment.
 * @returns True only when a `Bearer` header carries exactly the expected token.
 */
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
  return constantTimeEquals(providedDigest, expectedDigest);
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

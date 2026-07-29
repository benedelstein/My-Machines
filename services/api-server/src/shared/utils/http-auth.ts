/** Parsed username and password from an HTTP Basic authorization header. */
export interface BasicAuthorization {
  username: string;
  password: string;
}

/** Parses an HTTP Basic authorization header, returning null when malformed. */
export function parseBasicAuthorization(
  authorization: string | null,
): BasicAuthorization | null {
  const encoded = authorization?.match(/^Basic\s+(.+)$/i)?.[1];
  if (!encoded) {
    return null;
  }
  try {
    const decoded = atob(encoded);
    const separator = decoded.indexOf(":");
    if (separator < 0) {
      return null;
    }
    return {
      username: decoded.slice(0, separator),
      password: decoded.slice(separator + 1),
    };
  } catch {
    return null;
  }
}

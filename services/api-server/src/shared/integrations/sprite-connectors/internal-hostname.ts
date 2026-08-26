/**
 * Best-effort syntactic rejection for obviously internal connector targets.
 *
 * This is not the connector's SSRF boundary. It blocks common literal internal
 * addresses and suffixes only; it does not resolve DNS, defend against rebinding,
 * or control redirect-time credential forwarding. Sprites' connector test
 * executes from Fly's backend and proves reachability, not safety.
 *
 * @param hostname Hostname from a parsed URL, with IPv6 literals still bracketed.
 * @returns True when the hostname is loopback, link-local, or private.
 */
export function isInternalHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/\.$/u, "");
  if (
    normalized === "localhost"
    || normalized.endsWith(".localhost")
    || normalized.endsWith(".local")
    || normalized.endsWith(".internal")
  ) {
    return true;
  }
  if (normalized.startsWith("[")) {
    const ipv6 = normalized.slice(1, -1);
    return ipv6 === "::1"
      || ipv6 === "::"
      || /^f[cd]/u.test(ipv6)
      || ipv6.startsWith("fe80:")
      || ipv6.startsWith("::ffff:");
  }
  const octets = normalized.split(".").map((part) => Number(part));
  if (octets.length === 4 && octets.every((octet) => Number.isInteger(octet) && octet >= 0 && octet <= 255)) {
    const [first = 0, second = 0] = octets;
    return first === 0
      || first === 10
      || first === 127
      || (first === 100 && second >= 64 && second <= 127)
      || (first === 169 && second === 254)
      || (first === 172 && second >= 16 && second <= 31)
      || (first === 192 && second === 168)
      || first >= 224;
  }
  return false;
}

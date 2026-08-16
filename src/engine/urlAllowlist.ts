/**
 * Domain allowlist for the http_request node. This is the primary defense
 * against two distinct risks: SSRF (a workflow telling this server to hit
 * an internal address or a cloud metadata endpoint) and abuse of an
 * unauthenticated API as an open relay to fetch arbitrary external
 * content. An allowlist closes both at once — nothing not explicitly
 * approved is reachable, full stop.
 *
 * Fails closed: an empty allowlist blocks every http_request call, rather
 * than defaulting to "allow everything" if someone forgets to configure it.
 */

export function parseAllowlist(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0);
}

/** `entry` may be an exact host ("api.github.com") or a wildcard ("*.github.com"). */
function hostMatchesEntry(host: string, entry: string): boolean {
  if (entry.startsWith("*.")) {
    const suffix = entry.slice(1); // ".github.com"
    return host.endsWith(suffix) && host.length > suffix.length;
  }
  return host === entry;
}

export function isHostAllowed(hostname: string, allowlist: string[]): boolean {
  const host = hostname.toLowerCase();
  return allowlist.some((entry) => hostMatchesEntry(host, entry));
}

/** Returns an error message if the URL is not allowed, or null if it's fine. */
export function checkUrlAllowed(rawUrl: string, allowlist: string[]): string | null {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return `invalid URL: "${rawUrl}"`;
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return `URL scheme "${parsed.protocol}" is not allowed — only http: and https: are`;
  }

  if (allowlist.length === 0) {
    return "no domains are allowlisted (set ALLOWED_HTTP_DOMAINS) — every http_request URL is blocked until one is";
  }

  if (!isHostAllowed(parsed.hostname, allowlist)) {
    return `"${parsed.hostname}" is not in the allowed domains list`;
  }

  return null;
}

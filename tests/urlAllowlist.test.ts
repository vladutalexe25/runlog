import { describe, expect, it } from "vitest";
import { checkUrlAllowed, isHostAllowed, parseAllowlist } from "../src/engine/urlAllowlist.js";

describe("parseAllowlist", () => {
  it("splits, trims, and lowercases a comma-separated list", () => {
    expect(parseAllowlist(" Example.com, api.GitHub.com ,,")).toEqual(["example.com", "api.github.com"]);
  });

  it("returns an empty array for undefined or blank input", () => {
    expect(parseAllowlist(undefined)).toEqual([]);
    expect(parseAllowlist("")).toEqual([]);
    expect(parseAllowlist("   ")).toEqual([]);
  });
});

describe("isHostAllowed", () => {
  it("matches an exact host", () => {
    expect(isHostAllowed("example.com", ["example.com"])).toBe(true);
    expect(isHostAllowed("evil.com", ["example.com"])).toBe(false);
  });

  it("does not match a host that merely contains an allowed entry as a substring", () => {
    expect(isHostAllowed("example.com.attacker.net", ["example.com"])).toBe(false);
    expect(isHostAllowed("notexample.com", ["example.com"])).toBe(false);
  });

  it("matches subdomains via a *. wildcard entry, but not the bare domain", () => {
    expect(isHostAllowed("api.example.com", ["*.example.com"])).toBe(true);
    expect(isHostAllowed("a.b.example.com", ["*.example.com"])).toBe(true);
    expect(isHostAllowed("example.com", ["*.example.com"])).toBe(false);
  });

  it("is case-insensitive", () => {
    expect(isHostAllowed("Example.COM", ["example.com"])).toBe(true);
  });
});

describe("checkUrlAllowed", () => {
  const allowlist = ["api.example.com"];

  it("returns null (allowed) for a matching https URL", () => {
    expect(checkUrlAllowed("https://api.example.com/v1/thing", allowlist)).toBeNull();
  });

  it("blocks a host not on the allowlist", () => {
    expect(checkUrlAllowed("https://evil.com", allowlist)).toMatch(/not in the allowed domains/);
  });

  it("blocks every URL when the allowlist is empty", () => {
    expect(checkUrlAllowed("https://api.example.com", [])).toMatch(/no domains are allowlisted/);
  });

  it("blocks non-http(s) schemes even for an allowed host", () => {
    expect(checkUrlAllowed("ftp://api.example.com/x", allowlist)).toMatch(/scheme/);
    expect(checkUrlAllowed("file:///etc/passwd", allowlist)).toMatch(/scheme/);
  });

  it("blocks a malformed URL with a clear message", () => {
    expect(checkUrlAllowed("not a url", allowlist)).toMatch(/invalid URL/);
  });

  it("blocks common SSRF targets that aren't explicitly allowlisted", () => {
    expect(checkUrlAllowed("http://169.254.169.254/latest/meta-data", allowlist)).toMatch(/not in the allowed/);
    expect(checkUrlAllowed("http://localhost:5432", allowlist)).toMatch(/not in the allowed/);
    expect(checkUrlAllowed("http://127.0.0.1", allowlist)).toMatch(/not in the allowed/);
    expect(checkUrlAllowed("http://10.0.0.5", allowlist)).toMatch(/not in the allowed/);
  });
});

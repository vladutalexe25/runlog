import { describe, expect, it } from "vitest";
import { evaluateExpression } from "../src/engine/safeExpression.js";

describe("evaluateExpression — supported grammar", () => {
  it("returns input directly for a bare identifier", () => {
    expect(evaluateExpression("input", { a: 1 }, {})).toEqual({ a: 1 });
  });

  it("reads nested properties from input and context", () => {
    expect(evaluateExpression("input.body.title", { body: { title: "x" } }, {})).toBe("x");
    expect(evaluateExpression("context.extract", {}, { extract: 0.9 })).toBe(0.9);
  });

  it("evaluates arithmetic", () => {
    expect(evaluateExpression("input.n + 1", { n: 41 }, {})).toBe(42);
    expect(evaluateExpression("input * 10", 4, {})).toBe(40);
    expect(evaluateExpression("(1 + 2) * 3", null, {})).toBe(9);
  });

  it("evaluates comparisons", () => {
    expect(evaluateExpression("input.status === 200", { status: 200 }, {})).toBe(true);
    expect(evaluateExpression("context.extract >= 0.5", {}, { extract: 0.2 })).toBe(false);
  });

  it("evaluates string concatenation and literals", () => {
    expect(evaluateExpression('"todo: " + context.title', {}, { title: "x" })).toBe("todo: x");
    expect(evaluateExpression("true", null, {})).toBe(true);
    expect(evaluateExpression("false", null, {})).toBe(false);
    expect(evaluateExpression("null", null, {})).toBeNull();
  });

  it("evaluates a ternary", () => {
    expect(evaluateExpression('input.ok ? "yes" : "no"', { ok: true }, {})).toBe("yes");
    expect(evaluateExpression('input.ok ? "yes" : "no"', { ok: false }, {})).toBe("no");
  });

  it("short-circuits && and || without evaluating the unreachable side", () => {
    expect(evaluateExpression("input && input.foo", null, {})).toBe(null);
    expect(evaluateExpression("input || 5", null, {})).toBe(5);
  });

  it("evaluates array literals", () => {
    expect(evaluateExpression("[1, input, 3]", 2, {})).toEqual([1, 2, 3]);
  });

  it("returns undefined for property access through null/undefined instead of throwing", () => {
    expect(evaluateExpression("input.missing", null, {})).toBeUndefined();
    expect(evaluateExpression("input.a.b", { a: undefined }, {})).toBeUndefined();
  });
});

describe("evaluateExpression — blocks code execution, not just specific keywords", () => {
  it("cannot reach globals like process — unknown identifiers throw instead of resolving", () => {
    expect(() => evaluateExpression("process.env.DATABASE_URL", null, {})).toThrow(/unknown identifier "process"/);
    expect(() => evaluateExpression("global.process", null, {})).toThrow(/unknown identifier "global"/);
    expect(() => evaluateExpression("fetch", null, {})).toThrow(/unknown identifier "fetch"/);
  });

  it("parses but refuses to execute any function call, including import()", () => {
    // jsep parses this fine (it's a CallExpression) — the evaluator must
    // still refuse to run it. This is the actual RCE vector this whole
    // module exists to close.
    expect(() => evaluateExpression('import("node:child_process")', null, {})).toThrow(/not supported/);
    expect(() => evaluateExpression("(function(){ return 1; })()", null, {})).toThrow();
    expect(() => evaluateExpression("fetch('https://evil.com')", null, {})).toThrow(/not supported/);
  });

  it("blocks constructor-chain sandbox-escape attempts even as a plain value", () => {
    expect(() => evaluateExpression("input.constructor", { constructor: "x" }, {})).toThrow(
      /access to "constructor" is not allowed/,
    );
    expect(() => evaluateExpression("input.__proto__", {}, {})).toThrow(/access to "__proto__" is not allowed/);
  });

  it("has no eval or Function call in its implementation path (structural check)", async () => {
    // Belt-and-suspenders: read the module source itself and assert it
    // never actually *invokes* the two APIs this module exists to replace
    // (the doc comment above mentions them by name in prose, deliberately
    // without call syntax, so this checks for the parens too).
    const fs = await import("node:fs/promises");
    const src = await fs.readFile(new URL("../src/engine/safeExpression.ts", import.meta.url), "utf8");
    expect(src).not.toMatch(/\bnew\s+Function\s*\(/);
    expect(src).not.toMatch(/[^.\w]eval\s*\(/);
  });
});

describe("evaluateExpression — error handling", () => {
  it("throws a clear error for invalid syntax", () => {
    expect(() => evaluateExpression("input.", null, {})).toThrow(/invalid expression/);
  });

  it("throws a clear error for unsupported syntax like object literals", () => {
    expect(() => evaluateExpression("{ a: 1 }", null, {})).toThrow();
  });
});

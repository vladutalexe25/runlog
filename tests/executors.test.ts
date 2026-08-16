import { describe, expect, it, vi } from "vitest";
import {
  conditionExecutor,
  createDelayExecutor,
  createHttpRequestExecutor,
  createLLMExecutor,
  transformExecutor,
} from "../src/engine/executors.js";

describe("transformExecutor", () => {
  it("evaluates an expression against the node's input", async () => {
    const output = await transformExecutor({
      config: { expression: "input.value * 2" },
      input: { value: 21 },
      context: {},
    });
    expect(output).toBe(42);
  });

  it("can read prior node outputs from context", async () => {
    const output = await transformExecutor({
      config: { expression: "context.fetch.body.name" },
      input: {},
      context: { fetch: { body: { name: "Ada" } } },
    });
    expect(output).toBe("Ada");
  });

  it("throws a descriptive error when config.expression is missing", async () => {
    await expect(transformExecutor({ config: {}, input: {}, context: {} })).rejects.toThrow(
      /requires config.expression/,
    );
  });
});

describe("conditionExecutor", () => {
  it("returns true when the expression is truthy", async () => {
    const output = await conditionExecutor({
      config: { expression: "input.status === 200" },
      input: { status: 200 },
      context: {},
    });
    expect(output).toBe(true);
  });

  it("returns false when the expression is falsy", async () => {
    const output = await conditionExecutor({
      config: { expression: "input.status === 200" },
      input: { status: 500 },
      context: {},
    });
    expect(output).toBe(false);
  });

  it("coerces non-boolean results to a boolean", async () => {
    const output = await conditionExecutor({
      config: { expression: "input.count" },
      input: { count: 0 },
      context: {},
    });
    expect(output).toBe(false);
  });
});

describe("createDelayExecutor", () => {
  it("waits for config.ms using the injected sleep function and passes input through", async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    const executor = createDelayExecutor(sleep);
    const output = await executor({ config: { ms: 500 }, input: { keep: "me" }, context: {} });
    expect(sleep).toHaveBeenCalledWith(500);
    expect(output).toEqual({ keep: "me" });
  });

  it("rejects when config.ms is missing or negative", async () => {
    const executor = createDelayExecutor(vi.fn());
    await expect(executor({ config: {}, input: null, context: {} })).rejects.toThrow(/config.ms/);
    await expect(executor({ config: { ms: -1 }, input: null, context: {} })).rejects.toThrow(/config.ms/);
  });
});

describe("createHttpRequestExecutor", () => {
  it("returns the parsed JSON body and status for a successful response", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    const executor = createHttpRequestExecutor(fetchImpl as unknown as typeof fetch);
    const output = await executor({ config: { url: "https://example.com" }, input: null, context: {} });
    expect(output).toEqual({ status: 200, body: { ok: true } });
    expect(fetchImpl).toHaveBeenCalledWith("https://example.com", expect.objectContaining({ method: "GET" }));
  });

  it("throws when the response status is not ok", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("nope", { status: 500 }));
    const executor = createHttpRequestExecutor(fetchImpl as unknown as typeof fetch);
    await expect(
      executor({ config: { url: "https://example.com" }, input: null, context: {} }),
    ).rejects.toThrow(/status 500/);
  });

  it("throws a descriptive error when config.url is missing", async () => {
    const executor = createHttpRequestExecutor(vi.fn() as unknown as typeof fetch);
    await expect(executor({ config: {}, input: null, context: {} })).rejects.toThrow(/config.url/);
  });
});

describe("createLLMExecutor", () => {
  it("interpolates {{input}} into the prompt before calling the provider", async () => {
    const provider = { complete: vi.fn().mockResolvedValue({ label: "positive" }) };
    const executor = createLLMExecutor(provider);
    const output = await executor({
      config: { prompt: "classify: {{input}}" },
      input: { text: "great product" },
      context: {},
    });
    expect(provider.complete).toHaveBeenCalledWith({
      prompt: `classify: ${JSON.stringify({ text: "great product" })}`,
      config: { prompt: "classify: {{input}}" },
    });
    expect(output).toEqual({ label: "positive" });
  });

  it("throws a descriptive error when config.prompt is missing", async () => {
    const executor = createLLMExecutor({ complete: vi.fn() });
    await expect(executor({ config: {}, input: null, context: {} })).rejects.toThrow(/config.prompt/);
  });
});

import type { NodeExecutor, NodeExecutorArgs } from "./types.js";
import { checkUrlAllowed, parseAllowlist } from "./urlAllowlist.js";
import { evaluateExpression } from "./safeExpression.js";

/**
 * Built-in executors for the 5 supported node types. Each is a factory so
 * tests (and, later, the real app) can inject fakes for I/O — fetch, the
 * clock, an LLM provider — without touching the network or a real timer.
 */

type FetchLike = typeof fetch;

const MAX_REDIRECTS = 5;

/**
 * fetch()'s default `redirect: "follow"` checks the allowlist on the
 * initial URL only — a redirect (from an allowlisted host, an open
 * redirector, anything) to an internal address or a cloud metadata
 * endpoint would be followed silently, bypassing the allowlist entirely
 * after the first hop. `redirect: "manual"` is Node-specific behavior
 * (unlike a browser, there's no cross-origin "opaque redirect" — the
 * Location header is fully readable server-side), so each hop can be
 * re-checked against the same allowlist before being followed.
 */
async function fetchWithAllowlist(
  fetchImpl: FetchLike,
  url: string,
  init: RequestInit,
  allowedDomains: string[],
): Promise<Response> {
  let currentUrl = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const response = await fetchImpl(currentUrl, { ...init, redirect: "manual" });
    if (response.status < 300 || response.status >= 400) return response;

    const location = response.headers.get("location");
    if (!location) return response;

    const nextUrl = new URL(location, currentUrl).toString();
    const allowlistError = checkUrlAllowed(nextUrl, allowedDomains);
    if (allowlistError) {
      throw new Error(`http_request blocked on redirect to ${nextUrl}: ${allowlistError}`);
    }
    currentUrl = nextUrl;
  }
  throw new Error(`http_request exceeded ${MAX_REDIRECTS} redirects`);
}

export function createHttpRequestExecutor(fetchImpl: FetchLike = fetch, allowedDomains: string[] = []): NodeExecutor {
  return async ({ config }: NodeExecutorArgs) => {
    const url = config.url;
    if (typeof url !== "string" || url.length === 0) {
      throw new Error("http_request node requires config.url");
    }
    const allowlistError = checkUrlAllowed(url, allowedDomains);
    if (allowlistError) {
      throw new Error(`http_request blocked: ${allowlistError}`);
    }
    const method = typeof config.method === "string" ? config.method : "GET";
    const headers = (config.headers as Record<string, string> | undefined) ?? undefined;
    const body = config.body !== undefined ? JSON.stringify(config.body) : undefined;

    const response = await fetchWithAllowlist(fetchImpl, url, { method, headers, body }, allowedDomains);
    const text = await response.text();
    let parsed: unknown = text;
    try {
      parsed = text.length > 0 ? JSON.parse(text) : undefined;
    } catch {
      // Non-JSON response bodies are returned as raw text.
    }

    if (!response.ok) {
      throw new Error(`http_request failed with status ${response.status}`);
    }

    return { status: response.status, body: parsed };
  };
}

export const transformExecutor: NodeExecutor = async ({ config, input, context }) => {
  const expression = config.expression;
  if (typeof expression !== "string" || expression.length === 0) {
    throw new Error("transform node requires config.expression");
  }
  return evaluateExpression(expression, input, context);
};

export const conditionExecutor: NodeExecutor = async ({ config, input, context }) => {
  const expression = config.expression;
  if (typeof expression !== "string" || expression.length === 0) {
    throw new Error("condition node requires config.expression");
  }
  return Boolean(evaluateExpression(expression, input, context));
};

export function createDelayExecutor(
  sleepImpl: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): NodeExecutor {
  return async ({ config, input }) => {
    const ms = config.ms;
    if (typeof ms !== "number" || ms < 0) {
      throw new Error("delay node requires config.ms >= 0");
    }
    await sleepImpl(ms);
    return input;
  };
}

export interface LLMProvider {
  complete(args: { prompt: string; config: Record<string, unknown> }): Promise<unknown>;
}

export function createLLMExecutor(provider: LLMProvider): NodeExecutor {
  return async ({ config, input, context: _context }) => {
    const template = config.prompt;
    if (typeof template !== "string" || template.length === 0) {
      throw new Error("llm node requires config.prompt");
    }
    // Minimal {{path}} interpolation from input/context; the real
    // implementation and provider adapters (Ollama, hosted API) land in Phase 6.
    const prompt = template.replace(/\{\{\s*input\s*\}\}/g, JSON.stringify(input));
    return provider.complete({ prompt, config });
  };
}

export function defaultExecutors(): {
  http_request: NodeExecutor;
  transform: NodeExecutor;
  condition: NodeExecutor;
  delay: NodeExecutor;
} {
  return {
    http_request: createHttpRequestExecutor(fetch, parseAllowlist(process.env.ALLOWED_HTTP_DOMAINS)),
    transform: transformExecutor,
    condition: conditionExecutor,
    delay: createDelayExecutor(),
  };
}

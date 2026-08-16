import { describe, expect, it, vi } from "vitest";
import { executeWorkflow } from "../src/engine/engine.js";
import type { NodeExecutorMap, WorkflowDefinition, WorkflowNode } from "../src/engine/types.js";

const noopSleep = async () => {};

function makeNode(overrides: Partial<WorkflowNode> & { id: string }): WorkflowNode {
  return { type: "transform", name: overrides.id, config: { expression: "input" }, ...overrides };
}

function edge(id: string, source: string, target: string, branch?: "true" | "false") {
  return { id, source, target, branch };
}

describe("executeWorkflow — linear execution", () => {
  it("runs a single node successfully and returns a succeeded run", async () => {
    const workflow: WorkflowDefinition = {
      id: "wf",
      nodes: [makeNode({ id: "a", config: { expression: "input.n + 1" } })],
      edges: [],
    };
    const result = await executeWorkflow(workflow, { n: 1 }, { transform: (await import("../src/engine/executors.js")).transformExecutor });
    expect(result.status).toBe("succeeded");
    expect(result.nodeExecutions).toHaveLength(1);
    expect(result.nodeExecutions[0]).toMatchObject({ nodeId: "a", status: "succeeded", output: 2, attempts: 1 });
  });

  it("feeds each node's output as the next node's input", async () => {
    const { transformExecutor } = await import("../src/engine/executors.js");
    const workflow: WorkflowDefinition = {
      id: "wf",
      nodes: [
        makeNode({ id: "a", config: { expression: "input.n + 1" } }),
        makeNode({ id: "b", config: { expression: "input * 10" } }),
      ],
      edges: [edge("e1", "a", "b")],
    };
    const result = await executeWorkflow(workflow, { n: 1 }, { transform: transformExecutor });
    expect(result.status).toBe("succeeded");
    const b = result.nodeExecutions.find((e) => e.nodeId === "b")!;
    expect(b.input).toBe(2);
    expect(b.output).toBe(20);
  });

  it("passes the trigger payload as input to every root node", async () => {
    const { transformExecutor } = await import("../src/engine/executors.js");
    const workflow: WorkflowDefinition = {
      id: "wf",
      nodes: [makeNode({ id: "a" }), makeNode({ id: "b" })],
      edges: [],
    };
    const result = await executeWorkflow(workflow, { hello: "world" }, { transform: transformExecutor });
    expect(result.nodeExecutions.map((e) => e.input)).toEqual([{ hello: "world" }, { hello: "world" }]);
  });

  it("records started/finished timestamps and a non-negative duration per node", async () => {
    const { transformExecutor } = await import("../src/engine/executors.js");
    const workflow: WorkflowDefinition = { id: "wf", nodes: [makeNode({ id: "a" })], edges: [] };
    const result = await executeWorkflow(workflow, {}, { transform: transformExecutor });
    const exec = result.nodeExecutions[0]!;
    expect(exec.finishedAt.getTime()).toBeGreaterThanOrEqual(exec.startedAt.getTime());
    expect(exec.durationMs).toBeGreaterThanOrEqual(0);
  });
});

describe("executeWorkflow — node failure", () => {
  const failingExecutors: NodeExecutorMap = {
    transform: async () => {
      throw new Error("boom");
    },
  };

  it("marks a throwing node as failed", async () => {
    const workflow: WorkflowDefinition = { id: "wf", nodes: [makeNode({ id: "a" })], edges: [] };
    const result = await executeWorkflow(workflow, {}, failingExecutors, { sleep: noopSleep });
    expect(result.nodeExecutions[0]).toMatchObject({ status: "failed", error: "boom" });
  });

  it("marks the overall run as failed and includes the node name in the error", async () => {
    const workflow: WorkflowDefinition = { id: "wf", nodes: [makeNode({ id: "a", name: "Boom Node" })], edges: [] };
    const result = await executeWorkflow(workflow, {}, failingExecutors, { sleep: noopSleep });
    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/Boom Node/);
  });

  it("skips nodes downstream of a failed node", async () => {
    const workflow: WorkflowDefinition = {
      id: "wf",
      nodes: [makeNode({ id: "a" }), makeNode({ id: "b" })],
      edges: [edge("e1", "a", "b")],
    };
    const result = await executeWorkflow(
      workflow,
      {},
      { transform: async () => { throw new Error("boom"); } },
      { sleep: noopSleep },
    );
    const b = result.nodeExecutions.find((e) => e.nodeId === "b")!;
    expect(b.status).toBe("skipped");
  });

  it("still executes a branch that does not depend on the failed node", async () => {
    const executors: NodeExecutorMap = {
      transform: async ({ config }) => {
        if (config.fails) throw new Error("boom");
        return "ok";
      },
    };
    const workflow: WorkflowDefinition = {
      id: "wf",
      nodes: [makeNode({ id: "a", config: { fails: true } }), makeNode({ id: "b" })],
      edges: [],
    };
    const result = await executeWorkflow(workflow, {}, executors, { sleep: noopSleep });
    expect(result.nodeExecutions.find((e) => e.nodeId === "a")?.status).toBe("failed");
    expect(result.nodeExecutions.find((e) => e.nodeId === "b")?.status).toBe("succeeded");
  });

  it("fails a node with a descriptive error when no executor is registered for its type", async () => {
    const workflow: WorkflowDefinition = { id: "wf", nodes: [makeNode({ id: "a", type: "llm" })], edges: [] };
    const result = await executeWorkflow(workflow, {}, {}, { sleep: noopSleep });
    expect(result.nodeExecutions[0]).toMatchObject({ status: "failed" });
    expect(result.nodeExecutions[0]!.error).toMatch(/no executor registered/);
  });
});

describe("executeWorkflow — retries", () => {
  it("retries up to maxAttempts and then fails", async () => {
    const attempt = vi.fn().mockRejectedValue(new Error("still broken"));
    const workflow: WorkflowDefinition = {
      id: "wf",
      nodes: [makeNode({ id: "a", retry: { maxAttempts: 3, backoffMs: 5 } })],
      edges: [],
    };
    const result = await executeWorkflow(workflow, {}, { transform: attempt }, { sleep: noopSleep });
    expect(attempt).toHaveBeenCalledTimes(3);
    expect(result.nodeExecutions[0]).toMatchObject({ status: "failed", attempts: 3 });
  });

  it("succeeds if a later attempt recovers", async () => {
    const attempt = vi
      .fn()
      .mockRejectedValueOnce(new Error("first fails"))
      .mockRejectedValueOnce(new Error("second fails"))
      .mockResolvedValueOnce("third succeeds");
    const workflow: WorkflowDefinition = {
      id: "wf",
      nodes: [makeNode({ id: "a", retry: { maxAttempts: 3, backoffMs: 5 } })],
      edges: [],
    };
    const result = await executeWorkflow(workflow, {}, { transform: attempt }, { sleep: noopSleep });
    expect(result.nodeExecutions[0]).toMatchObject({ status: "succeeded", attempts: 3, output: "third succeeds" });
  });

  it("sleeps for backoffMs between attempts, once fewer than the number of attempts", async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    const attempt = vi.fn().mockRejectedValue(new Error("nope"));
    const workflow: WorkflowDefinition = {
      id: "wf",
      nodes: [makeNode({ id: "a", retry: { maxAttempts: 4, backoffMs: 25 } })],
      edges: [],
    };
    await executeWorkflow(workflow, {}, { transform: attempt }, { sleep });
    expect(sleep).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledWith(25);
  });

  it("attempts exactly once when no retry config is given", async () => {
    const attempt = vi.fn().mockRejectedValue(new Error("nope"));
    const workflow: WorkflowDefinition = { id: "wf", nodes: [makeNode({ id: "a" })], edges: [] };
    const result = await executeWorkflow(workflow, {}, { transform: attempt }, { sleep: noopSleep });
    expect(attempt).toHaveBeenCalledTimes(1);
    expect(result.nodeExecutions[0]!.attempts).toBe(1);
  });
});

describe("executeWorkflow — timeouts", () => {
  it("fails a node that exceeds its timeoutMs", async () => {
    const hangs = () => new Promise(() => {});
    const workflow: WorkflowDefinition = {
      id: "wf",
      nodes: [makeNode({ id: "a", timeoutMs: 20 })],
      edges: [],
    };
    const result = await executeWorkflow(workflow, {}, { transform: hangs }, { sleep: noopSleep });
    expect(result.nodeExecutions[0]).toMatchObject({ status: "failed" });
    expect(result.nodeExecutions[0]!.error).toMatch(/timed out after 20ms/);
  });

  it("succeeds when the node finishes within its timeoutMs", async () => {
    const fast = () => new Promise((resolve) => setTimeout(() => resolve("done"), 5));
    const workflow: WorkflowDefinition = {
      id: "wf",
      nodes: [makeNode({ id: "a", timeoutMs: 200 })],
      edges: [],
    };
    const result = await executeWorkflow(workflow, {}, { transform: fast }, { sleep: noopSleep });
    expect(result.nodeExecutions[0]).toMatchObject({ status: "succeeded", output: "done" });
  });

  it("applies the timeout independently to every retry attempt", async () => {
    const attempt = vi
      .fn()
      .mockImplementationOnce(() => new Promise(() => {}))
      .mockImplementationOnce(() => Promise.resolve("recovered"));
    const workflow: WorkflowDefinition = {
      id: "wf",
      nodes: [makeNode({ id: "a", timeoutMs: 15, retry: { maxAttempts: 2, backoffMs: 5 } })],
      edges: [],
    };
    const result = await executeWorkflow(workflow, {}, { transform: attempt }, { sleep: noopSleep });
    expect(result.nodeExecutions[0]).toMatchObject({ status: "succeeded", attempts: 2, output: "recovered" });
  });
});

describe("executeWorkflow — condition branching", () => {
  const executors: NodeExecutorMap = {
    condition: async ({ config, input }) => {
      const pass = (input as { pass: boolean }).pass;
      return config.expression === "true" ? pass : !pass;
    },
    transform: async ({ input }) => input,
  };

  function branchingWorkflow(): WorkflowDefinition {
    return {
      id: "wf",
      nodes: [
        makeNode({ id: "cond", type: "condition", config: { expression: "true" } }),
        makeNode({ id: "onTrue" }),
        makeNode({ id: "onFalse" }),
      ],
      edges: [edge("e1", "cond", "onTrue", "true"), edge("e2", "cond", "onFalse", "false")],
    };
  }

  it("runs only the true branch when the condition is true", async () => {
    const result = await executeWorkflow(branchingWorkflow(), { pass: true }, executors, { sleep: noopSleep });
    expect(result.nodeExecutions.find((e) => e.nodeId === "onTrue")?.status).toBe("succeeded");
    expect(result.nodeExecutions.find((e) => e.nodeId === "onFalse")?.status).toBe("skipped");
  });

  it("runs only the false branch when the condition is false", async () => {
    const result = await executeWorkflow(branchingWorkflow(), { pass: false }, executors, { sleep: noopSleep });
    expect(result.nodeExecutions.find((e) => e.nodeId === "onTrue")?.status).toBe("skipped");
    expect(result.nodeExecutions.find((e) => e.nodeId === "onFalse")?.status).toBe("succeeded");
  });

  it("skips both branches when the condition node itself fails", async () => {
    const failingCond: NodeExecutorMap = {
      condition: async () => {
        throw new Error("boom");
      },
    };
    const result = await executeWorkflow(branchingWorkflow(), { pass: true }, failingCond, { sleep: noopSleep });
    expect(result.nodeExecutions.find((e) => e.nodeId === "onTrue")?.status).toBe("skipped");
    expect(result.nodeExecutions.find((e) => e.nodeId === "onFalse")?.status).toBe("skipped");
  });

  it("resumes after a branch: a merge node runs once via whichever branch actually executed", async () => {
    const workflow: WorkflowDefinition = {
      id: "wf",
      nodes: [
        makeNode({ id: "cond", type: "condition", config: { expression: "true" } }),
        makeNode({ id: "onTrue" }),
        makeNode({ id: "onFalse" }),
        makeNode({ id: "merge" }),
      ],
      edges: [
        edge("e1", "cond", "onTrue", "true"),
        edge("e2", "cond", "onFalse", "false"),
        edge("e3", "onTrue", "merge"),
        edge("e4", "onFalse", "merge"),
      ],
    };
    const result = await executeWorkflow(workflow, { pass: true }, executors, { sleep: noopSleep });
    const merge = result.nodeExecutions.find((e) => e.nodeId === "merge")!;
    expect(merge.status).toBe("succeeded");
    expect(result.nodeExecutions.filter((e) => e.nodeId === "merge")).toHaveLength(1);
  });
});

describe("executeWorkflow — full integration", () => {
  it("runs http -> transform -> condition -> branch end to end", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ score: 0.9 }), { status: 200 }));
    const { createHttpRequestExecutor, transformExecutor, conditionExecutor } = await import(
      "../src/engine/executors.js"
    );

    const workflow: WorkflowDefinition = {
      id: "wf",
      nodes: [
        makeNode({ id: "fetch", type: "http_request", config: { url: "https://example.com" } }),
        makeNode({ id: "extract", config: { expression: "input.body.score" } }),
        makeNode({ id: "cond", type: "condition", config: { expression: "context.extract >= 0.5" } }),
        makeNode({ id: "high" }),
        makeNode({ id: "low" }),
      ],
      edges: [
        edge("e1", "fetch", "extract"),
        edge("e2", "extract", "cond"),
        edge("e3", "cond", "high", "true"),
        edge("e4", "cond", "low", "false"),
      ],
    };

    const result = await executeWorkflow(
      workflow,
      { webhook: true },
      {
        http_request: createHttpRequestExecutor(fetchImpl as unknown as typeof fetch, ["example.com"]),
        transform: transformExecutor,
        condition: conditionExecutor,
      },
      { sleep: noopSleep },
    );

    expect(result.status).toBe("succeeded");
    expect(result.nodeExecutions.find((e) => e.nodeId === "extract")?.output).toBe(0.9);
    expect(result.nodeExecutions.find((e) => e.nodeId === "cond")?.output).toBe(true);
    expect(result.nodeExecutions.find((e) => e.nodeId === "high")?.status).toBe("succeeded");
    expect(result.nodeExecutions.find((e) => e.nodeId === "low")?.status).toBe("skipped");
    expect(result.nodeExecutions).toHaveLength(5);
  });
});

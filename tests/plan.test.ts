import { describe, expect, it } from "vitest";
import { buildExecutionPlan } from "../src/engine/plan.js";
import { CycleError, type WorkflowDefinition } from "../src/engine/types.js";

function node(id: string): WorkflowDefinition["nodes"][number] {
  return { id, type: "transform", name: id, config: { expression: "input" } };
}

function edge(id: string, source: string, target: string, branch?: "true" | "false") {
  return { id, source, target, branch };
}

describe("buildExecutionPlan", () => {
  it("orders a linear chain start to finish", () => {
    const workflow: WorkflowDefinition = {
      id: "wf",
      nodes: [node("a"), node("b"), node("c")],
      edges: [edge("e1", "a", "b"), edge("e2", "b", "c")],
    };
    expect(buildExecutionPlan(workflow)).toEqual(["a", "b", "c"]);
  });

  it("places a condition node before both of its branches", () => {
    const workflow: WorkflowDefinition = {
      id: "wf",
      nodes: [node("a"), node("cond"), node("t"), node("f")],
      edges: [
        edge("e1", "a", "cond"),
        edge("e2", "cond", "t", "true"),
        edge("e3", "cond", "f", "false"),
      ],
    };
    const plan = buildExecutionPlan(workflow);
    expect(plan.indexOf("cond")).toBeLessThan(plan.indexOf("t"));
    expect(plan.indexOf("cond")).toBeLessThan(plan.indexOf("f"));
    expect(plan).toHaveLength(4);
  });

  it("throws CycleError when the graph has a cycle", () => {
    const workflow: WorkflowDefinition = {
      id: "wf",
      nodes: [node("a"), node("b")],
      edges: [edge("e1", "a", "b"), edge("e2", "b", "a")],
    };
    expect(() => buildExecutionPlan(workflow)).toThrow(CycleError);
  });

  it("supports multiple independent root nodes", () => {
    const workflow: WorkflowDefinition = {
      id: "wf",
      nodes: [node("a"), node("b")],
      edges: [],
    };
    const plan = buildExecutionPlan(workflow);
    expect(new Set(plan)).toEqual(new Set(["a", "b"]));
  });

  it("throws when an edge references an unknown node", () => {
    const workflow: WorkflowDefinition = {
      id: "wf",
      nodes: [node("a")],
      edges: [edge("e1", "a", "ghost")],
    };
    expect(() => buildExecutionPlan(workflow)).toThrow(/unknown node/);
  });

  it("returns a single node for a single-node workflow", () => {
    const workflow: WorkflowDefinition = { id: "wf", nodes: [node("a")], edges: [] };
    expect(buildExecutionPlan(workflow)).toEqual(["a"]);
  });

  it("returns an empty plan for an empty workflow", () => {
    const workflow: WorkflowDefinition = { id: "wf", nodes: [], edges: [] };
    expect(buildExecutionPlan(workflow)).toEqual([]);
  });

  it("orders a diamond graph so the merge node comes last", () => {
    const workflow: WorkflowDefinition = {
      id: "wf",
      nodes: [node("a"), node("b"), node("c"), node("d")],
      edges: [edge("e1", "a", "b"), edge("e2", "a", "c"), edge("e3", "b", "d"), edge("e4", "c", "d")],
    };
    const plan = buildExecutionPlan(workflow);
    expect(plan.indexOf("a")).toBeLessThan(plan.indexOf("b"));
    expect(plan.indexOf("a")).toBeLessThan(plan.indexOf("c"));
    expect(plan.indexOf("d")).toBe(3);
  });
});

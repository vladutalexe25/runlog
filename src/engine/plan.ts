import { CycleError, type WorkflowDefinition } from "./types.js";

/**
 * Produces a topological order of node ids given the workflow's edges.
 * This is the static plan: it fixes a valid execution order up front.
 * Runtime branch decisions (which edges are actually followed) are
 * resolved separately, during execution, since they depend on node output.
 */
export function buildExecutionPlan(workflow: WorkflowDefinition): string[] {
  const nodeIds = new Set(workflow.nodes.map((n) => n.id));
  const inDegree = new Map<string, number>();
  const adjacency = new Map<string, string[]>();

  for (const id of nodeIds) {
    inDegree.set(id, 0);
    adjacency.set(id, []);
  }

  for (const edge of workflow.edges) {
    if (!nodeIds.has(edge.source) || !nodeIds.has(edge.target)) {
      throw new Error(`edge ${edge.id} references an unknown node`);
    }
    adjacency.get(edge.source)!.push(edge.target);
    inDegree.set(edge.target, (inDegree.get(edge.target) ?? 0) + 1);
  }

  // Stable order: seed the queue with roots in the order nodes were declared.
  const queue = workflow.nodes.map((n) => n.id).filter((id) => inDegree.get(id) === 0);
  const order: string[] = [];

  while (queue.length > 0) {
    const id = queue.shift()!;
    order.push(id);
    for (const next of adjacency.get(id) ?? []) {
      const remaining = (inDegree.get(next) ?? 0) - 1;
      inDegree.set(next, remaining);
      if (remaining === 0) queue.push(next);
    }
  }

  if (order.length !== workflow.nodes.length) {
    throw new CycleError();
  }

  return order;
}

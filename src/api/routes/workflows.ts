import { Router } from "express";
import { NODE_TYPES } from "../../engine/types.js";
import {
  createWorkflow,
  enqueueRun,
  getWorkflowWithGraph,
  listRunsForWorkflow,
  listWorkflows,
  type CreateWorkflowEdgeInput,
  type CreateWorkflowNodeInput,
} from "../../db/repository.js";

export const workflowsRouter = Router();

function validateNodes(input: unknown): { errors: string[]; nodes: CreateWorkflowNodeInput[] } {
  const errors: string[] = [];
  const nodes = Array.isArray(input) ? input : [];
  if (!Array.isArray(input)) errors.push("nodes must be an array");

  for (const [i, raw] of nodes.entries()) {
    const n = raw as Partial<CreateWorkflowNodeInput>;
    if (typeof n.id !== "string" || n.id.length === 0) errors.push(`nodes[${i}].id is required`);
    if (typeof n.name !== "string" || n.name.length === 0) errors.push(`nodes[${i}].name is required`);
    if (typeof n.type !== "string" || !NODE_TYPES.includes(n.type as (typeof NODE_TYPES)[number])) {
      errors.push(`nodes[${i}].type must be one of ${NODE_TYPES.join(", ")}`);
    }
    if (n.config !== undefined && typeof n.config !== "object") errors.push(`nodes[${i}].config must be an object`);
  }

  return { errors, nodes: nodes as CreateWorkflowNodeInput[] };
}

function validateEdges(
  input: unknown,
  nodeIds: Set<string>,
): { errors: string[]; edges: CreateWorkflowEdgeInput[] } {
  const errors: string[] = [];
  const edges = Array.isArray(input) ? input : [];
  if (!Array.isArray(input)) errors.push("edges must be an array");

  for (const [i, raw] of edges.entries()) {
    const e = raw as Partial<CreateWorkflowEdgeInput>;
    if (typeof e.id !== "string" || e.id.length === 0) errors.push(`edges[${i}].id is required`);
    if (typeof e.source !== "string" || !nodeIds.has(e.source)) {
      errors.push(`edges[${i}].source must reference a node in this workflow`);
    }
    if (typeof e.target !== "string" || !nodeIds.has(e.target)) {
      errors.push(`edges[${i}].target must reference a node in this workflow`);
    }
    if (e.branch !== undefined && e.branch !== "true" && e.branch !== "false") {
      errors.push(`edges[${i}].branch must be "true" or "false" if present`);
    }
  }

  return { errors, edges: edges as CreateWorkflowEdgeInput[] };
}

workflowsRouter.post("/workflows", async (req, res) => {
  const { name, description, nodes: nodesInput, edges: edgesInput } = req.body ?? {};

  if (typeof name !== "string" || name.length === 0) {
    return res.status(400).json({ error: "name is required" });
  }

  const { errors: nodeErrors, nodes } = validateNodes(nodesInput ?? []);
  const nodeIds = new Set(nodes.map((n) => n.id));
  const { errors: edgeErrors, edges } = validateEdges(edgesInput ?? [], nodeIds);

  const errors = [...nodeErrors, ...edgeErrors];
  if (errors.length > 0) return res.status(400).json({ errors });

  const workflow = await createWorkflow({ name, description, nodes, edges });
  res.status(201).json(workflow);
});

workflowsRouter.get("/workflows", async (_req, res) => {
  res.json(await listWorkflows());
});

workflowsRouter.get("/workflows/:id", async (req, res) => {
  const graph = await getWorkflowWithGraph(req.params.id);
  if (!graph) return res.status(404).json({ error: "workflow not found" });
  res.json(graph);
});

workflowsRouter.post("/workflows/:id/trigger", async (req, res) => {
  const graph = await getWorkflowWithGraph(req.params.id);
  if (!graph) return res.status(404).json({ error: "workflow not found" });

  const run = await enqueueRun(req.params.id, "manual", req.body ?? {});
  res.status(202).json(run);
});

workflowsRouter.get("/workflows/:id/runs", async (req, res) => {
  const graph = await getWorkflowWithGraph(req.params.id);
  if (!graph) return res.status(404).json({ error: "workflow not found" });

  res.json(await listRunsForWorkflow(req.params.id));
});

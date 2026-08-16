import { Router } from "express";
import { NODE_TYPES } from "../../engine/types.js";
import { checkUrlAllowed, parseAllowlist } from "../../engine/urlAllowlist.js";
import {
  clearRunHistory,
  createWorkflow,
  deleteWorkflow,
  enqueueRun,
  getWorkflowWithGraph,
  listRunsForWorkflow,
  listWorkflows,
  updateWorkflow,
  type CreateWorkflowEdgeInput,
  type CreateWorkflowInput,
  type CreateWorkflowNodeInput,
} from "../../db/repository.js";
import { logger } from "../../logger.js";

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

    if (n.type === "http_request" && typeof n.config?.url === "string") {
      const allowlistError = checkUrlAllowed(n.config.url, parseAllowlist(process.env.ALLOWED_HTTP_DOMAINS));
      if (allowlistError) errors.push(`nodes[${i}].config.url: ${allowlistError}`);
    }
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

function validateWorkflowBody(body: unknown): { errors: string[]; input?: CreateWorkflowInput } {
  const { name, description, nodes: nodesInput, edges: edgesInput } = (body ?? {}) as Record<string, unknown>;

  const errors: string[] = [];
  if (typeof name !== "string" || name.length === 0) errors.push("name is required");

  const { errors: nodeErrors, nodes } = validateNodes(nodesInput ?? []);
  const nodeIds = new Set(nodes.map((n) => n.id));
  const { errors: edgeErrors, edges } = validateEdges(edgesInput ?? [], nodeIds);
  errors.push(...nodeErrors, ...edgeErrors);

  if (errors.length > 0) return { errors };
  return {
    errors,
    input: { name: name as string, description: description as string | undefined, nodes, edges },
  };
}

workflowsRouter.post("/workflows", async (req, res) => {
  const { errors, input } = validateWorkflowBody(req.body);
  if (errors.length > 0 || !input) return res.status(400).json({ errors });

  const workflow = await createWorkflow(input);
  res.status(201).json(workflow);
});

workflowsRouter.put("/workflows/:id", async (req, res) => {
  const { errors, input } = validateWorkflowBody(req.body);
  if (errors.length > 0 || !input) return res.status(400).json({ errors });

  const workflow = await updateWorkflow(req.params.id, input);
  if (!workflow) return res.status(404).json({ error: "workflow not found" });
  res.json(workflow);
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
  logger.info("run enqueued", { runId: run.id, workflowId: req.params.id, triggerType: "manual" });
  res.status(202).json(run);
});

workflowsRouter.get("/workflows/:id/runs", async (req, res) => {
  const graph = await getWorkflowWithGraph(req.params.id);
  if (!graph) return res.status(404).json({ error: "workflow not found" });

  res.json(await listRunsForWorkflow(req.params.id));
});

workflowsRouter.delete("/workflows/:id", async (req, res) => {
  const deleted = await deleteWorkflow(req.params.id);
  if (!deleted) return res.status(404).json({ error: "workflow not found" });
  res.status(204).send();
});

workflowsRouter.delete("/workflows/:id/runs", async (req, res) => {
  const graph = await getWorkflowWithGraph(req.params.id);
  if (!graph) return res.status(404).json({ error: "workflow not found" });

  const count = await clearRunHistory(req.params.id);
  res.json({ deleted: count });
});

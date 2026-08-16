import { Router } from "express";
import { enqueueRun, getWorkflowWithGraph } from "../../db/repository.js";
import { logger } from "../../logger.js";

export const webhooksRouter = Router();

webhooksRouter.post("/webhooks/:workflowId", async (req, res) => {
  const graph = await getWorkflowWithGraph(req.params.workflowId);
  if (!graph) return res.status(404).json({ error: "workflow not found" });

  const run = await enqueueRun(req.params.workflowId, "webhook", req.body ?? {});
  logger.info("run enqueued", { runId: run.id, workflowId: req.params.workflowId, triggerType: "webhook" });
  res.status(202).json({ runId: run.id, status: run.status });
});

import * as Sentry from "@sentry/node";
import { executeWorkflow } from "../engine/engine.js";
import { defaultExecutors } from "../engine/executors.js";
import type { RunResult, WorkflowDefinition } from "../engine/types.js";
import {
  claimNextPendingRun,
  getWorkflowWithGraph,
  markRunFailed,
  recordRunResult,
  toWorkflowDefinition,
} from "../db/repository.js";
import { logger } from "../logger.js";

const executors = defaultExecutors();

/**
 * The workflow's "answer": outputs of nodes nothing else depends on. Not
 * every succeeded node — just the ones a human would call the end result.
 */
function terminalNodeOutputs(definition: WorkflowDefinition, result: RunResult): Record<string, unknown> {
  const nodesWithOutgoingEdge = new Set(definition.edges.map((e) => e.source));
  const terminalNodeIds = new Set(
    definition.nodes.filter((n) => !nodesWithOutgoingEdge.has(n.id)).map((n) => n.id),
  );

  const outputs: Record<string, unknown> = {};
  for (const exec of result.nodeExecutions) {
    if (terminalNodeIds.has(exec.nodeId) && exec.status === "succeeded") {
      outputs[exec.nodeId] = exec.output;
    }
  }
  return outputs;
}

/**
 * Claims and runs at most one pending run. Returns whether it did anything,
 * so the caller can poll again immediately instead of waiting a full tick.
 */
export async function processNextRun(): Promise<boolean> {
  const run = await claimNextPendingRun();
  if (!run) return false;

  logger.info("run claimed", { runId: run.id, workflowId: run.workflowId, triggerType: run.triggerType });

  try {
    const graph = await getWorkflowWithGraph(run.workflowId);
    if (!graph) {
      logger.error("workflow no longer exists", { runId: run.id, workflowId: run.workflowId });
      await markRunFailed(run.id, `workflow ${run.workflowId} no longer exists`);
      return true;
    }

    const definition = toWorkflowDefinition(run.workflowId, graph.nodes, graph.edges);
    const result = await executeWorkflow(definition, run.triggerPayload, executors);
    await recordRunResult(run.id, result);

    const durationMs = result.finishedAt.getTime() - result.startedAt.getTime();
    if (result.status === "succeeded") {
      logger.info("run succeeded", {
        runId: run.id,
        workflowId: run.workflowId,
        durationMs,
        result: terminalNodeOutputs(definition, result),
      });
    } else {
      const failedNodes = result.nodeExecutions.filter((e) => e.status === "failed").map((e) => e.nodeId);
      logger.error("run failed", {
        runId: run.id,
        workflowId: run.workflowId,
        durationMs,
        error: result.error,
        failedNodes,
      });
      // Reported as its own event, not just a log line, so a run failure is
      // findable in Sentry by runId/workflowId alone — the acceptance bar
      // for this phase is diagnosing a break from Sentry without reading code.
      Sentry.captureException(new Error(result.error ?? "run failed"), {
        tags: { runId: run.id, workflowId: run.workflowId },
        extra: { failedNodes, durationMs, triggerType: run.triggerType },
      });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error("processor crashed", {
      runId: run.id,
      workflowId: run.workflowId,
      error: message,
      stack: err instanceof Error ? err.stack : undefined,
    });
    Sentry.captureException(err, {
      tags: { runId: run.id, workflowId: run.workflowId },
      extra: { triggerType: run.triggerType },
    });
    await markRunFailed(run.id, `processor error: ${message}`);
  }

  return true;
}

export function startJobLoop(pollIntervalMs = 1000): { stop: () => void } {
  let stopped = false;

  const tick = async () => {
    if (stopped) return;
    let processedSomething = false;
    try {
      processedSomething = await processNextRun();
    } catch (err) {
      logger.error("job loop tick failed", { error: err instanceof Error ? err.message : String(err) });
    }
    if (stopped) return;
    setTimeout(tick, processedSomething ? 0 : pollIntervalMs);
  };

  void tick();

  return {
    stop: () => {
      stopped = true;
    },
  };
}

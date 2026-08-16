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

  console.log(`[run ${run.id}] claimed`);

  try {
    const graph = await getWorkflowWithGraph(run.workflowId);
    if (!graph) {
      await markRunFailed(run.id, `workflow ${run.workflowId} no longer exists`);
      return true;
    }

    const definition = toWorkflowDefinition(run.workflowId, graph.nodes, graph.edges);
    const result = await executeWorkflow(definition, run.triggerPayload, executors);
    await recordRunResult(run.id, result);

    const durationMs = result.finishedAt.getTime() - result.startedAt.getTime();
    if (result.status === "succeeded") {
      console.log(
        `[run ${run.id}] succeeded in ${durationMs}ms — result:`,
        JSON.stringify(terminalNodeOutputs(definition, result)),
      );
    } else {
      const failedNodes = result.nodeExecutions.filter((e) => e.status === "failed").map((e) => e.nodeId);
      console.error(`[run ${run.id}] failed in ${durationMs}ms — ${result.error} (node(s): ${failedNodes.join(", ")})`);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[run ${run.id}] processor crashed: ${message}`);
    if (err instanceof Error && err.stack) console.error(err.stack);
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
      console.error("job loop tick failed:", err instanceof Error ? err.message : err);
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

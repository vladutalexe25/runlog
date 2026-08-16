import { executeWorkflow } from "../engine/engine.js";
import { defaultExecutors } from "../engine/executors.js";
import {
  claimNextPendingRun,
  getWorkflowWithGraph,
  markRunFailed,
  recordRunResult,
  toWorkflowDefinition,
} from "../db/repository.js";

const executors = defaultExecutors();

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

    console.log(`[run ${run.id}] finished: ${result.status}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[run ${run.id}] processor crashed: ${message}`);
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

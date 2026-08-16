import { buildExecutionPlan } from "./plan.js";
import {
  TimeoutError,
  type ExecuteWorkflowOptions,
  type ExecutionContext,
  type NodeExecutionResult,
  type NodeExecutorMap,
  type RunResult,
  type TriggerPayload,
  type WorkflowDefinition,
  type WorkflowEdge,
} from "./types.js";

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TimeoutError(ms)), ms);
  });
  // Prevent an unhandled-rejection warning if `promise` loses the race and
  // later rejects on its own; the race's own consumer already ran.
  promise.catch(() => {});
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Decide whether `edge`'s target should run, given what its source did.
 * A plain edge (no `branch`) only requires the source to have succeeded.
 * A branch edge additionally requires the source's boolean output to match.
 */
function edgeIsSatisfied(edge: WorkflowEdge, sourceStatus: string | undefined, sourceOutput: unknown): boolean {
  if (sourceStatus !== "succeeded") return false;
  if (edge.branch === undefined) return true;
  return edge.branch === "true" ? sourceOutput === true : sourceOutput === false;
}

export async function executeWorkflow(
  workflow: WorkflowDefinition,
  triggerPayload: TriggerPayload,
  executors: NodeExecutorMap,
  options: ExecuteWorkflowOptions = {},
): Promise<RunResult> {
  const sleep = options.sleep ?? defaultSleep;
  const plan = buildExecutionPlan(workflow);

  const nodeById = new Map(workflow.nodes.map((n) => [n.id, n]));
  const incomingByTarget = new Map<string, WorkflowEdge[]>();
  for (const edge of workflow.edges) {
    const list = incomingByTarget.get(edge.target) ?? [];
    list.push(edge);
    incomingByTarget.set(edge.target, list);
  }

  const context: ExecutionContext = {};
  const nodeStatus = new Map<string, "succeeded" | "failed" | "skipped">();
  const nodeExecutions: NodeExecutionResult[] = [];

  const runStartedAt = new Date();
  let runFailed = false;
  let runError: string | undefined;

  for (const nodeId of plan) {
    const node = nodeById.get(nodeId)!;
    const incoming = incomingByTarget.get(nodeId) ?? [];

    let eligible = true;
    let input: unknown = triggerPayload;

    if (incoming.length > 0) {
      const matched = incoming.find((edge) => edgeIsSatisfied(edge, nodeStatus.get(edge.source), context[edge.source]));
      eligible = matched !== undefined;
      input = matched ? context[matched.source] : undefined;
    }

    if (!eligible) {
      const now = new Date();
      nodeStatus.set(nodeId, "skipped");
      nodeExecutions.push({
        nodeId,
        status: "skipped",
        attempts: 0,
        input: undefined,
        startedAt: now,
        finishedAt: now,
        durationMs: 0,
      });
      continue;
    }

    const executor = executors[node.type];
    const maxAttempts = Math.max(1, node.retry?.maxAttempts ?? 1);
    const backoffMs = node.retry?.backoffMs ?? 0;

    const nodeStartedAt = new Date();
    let attempt = 0;
    let output: unknown;
    let lastError: string | undefined;
    let succeeded = false;

    while (attempt < maxAttempts && !succeeded) {
      attempt++;
      try {
        if (!executor) {
          throw new Error(`no executor registered for node type "${node.type}"`);
        }
        const run = executor({ config: node.config, input, context });
        output = node.timeoutMs !== undefined ? await withTimeout(run, node.timeoutMs) : await run;
        succeeded = true;
      } catch (err) {
        lastError = errorMessage(err);
        if (attempt < maxAttempts) await sleep(backoffMs);
      }
    }

    const nodeFinishedAt = new Date();
    const durationMs = nodeFinishedAt.getTime() - nodeStartedAt.getTime();

    if (succeeded) {
      context[nodeId] = output;
      nodeStatus.set(nodeId, "succeeded");
      nodeExecutions.push({
        nodeId,
        status: "succeeded",
        attempts: attempt,
        input,
        output,
        startedAt: nodeStartedAt,
        finishedAt: nodeFinishedAt,
        durationMs,
      });
    } else {
      nodeStatus.set(nodeId, "failed");
      nodeExecutions.push({
        nodeId,
        status: "failed",
        attempts: attempt,
        input,
        error: lastError,
        startedAt: nodeStartedAt,
        finishedAt: nodeFinishedAt,
        durationMs,
      });
      runFailed = true;
      runError ??= `node "${node.name}" (${nodeId}) failed: ${lastError}`;
    }
  }

  const runFinishedAt = new Date();

  return {
    status: runFailed ? "failed" : "succeeded",
    startedAt: runStartedAt,
    finishedAt: runFinishedAt,
    error: runError,
    nodeExecutions,
  };
}

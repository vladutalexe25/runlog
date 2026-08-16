export type NodeType = "http_request" | "transform" | "condition" | "delay" | "llm";

export interface RetryConfig {
  maxAttempts: number;
  backoffMs?: number;
}

export interface WorkflowNode {
  id: string;
  type: NodeType;
  name: string;
  config: Record<string, unknown>;
  timeoutMs?: number;
  retry?: RetryConfig;
}

export interface WorkflowEdge {
  id: string;
  source: string;
  target: string;
  /** Only meaningful when `source` is a `condition` node. */
  branch?: "true" | "false";
}

export interface WorkflowDefinition {
  id: string;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
}

export type TriggerPayload = unknown;

/** Outputs produced so far, keyed by node id. Used for expression interpolation. */
export type ExecutionContext = Record<string, unknown>;

export interface NodeExecutorArgs {
  config: Record<string, unknown>;
  input: unknown;
  context: ExecutionContext;
}

export type NodeExecutor = (args: NodeExecutorArgs) => Promise<unknown>;

export type NodeExecutorMap = Partial<Record<NodeType, NodeExecutor>>;

export type NodeExecutionStatus = "succeeded" | "failed" | "skipped";

export interface NodeExecutionResult {
  nodeId: string;
  status: NodeExecutionStatus;
  attempts: number;
  input: unknown;
  output?: unknown;
  error?: string;
  startedAt: Date;
  finishedAt: Date;
  durationMs: number;
}

export type RunStatus = "succeeded" | "failed";

export interface RunResult {
  status: RunStatus;
  startedAt: Date;
  finishedAt: Date;
  error?: string;
  nodeExecutions: NodeExecutionResult[];
}

export interface ExecuteWorkflowOptions {
  /** Injectable so tests don't have to wait on real timers. */
  sleep?: (ms: number) => Promise<void>;
}

export class TimeoutError extends Error {
  constructor(ms: number) {
    super(`timed out after ${ms}ms`);
    this.name = "TimeoutError";
  }
}

export class CycleError extends Error {
  constructor() {
    super("workflow contains a cycle");
    this.name = "CycleError";
  }
}

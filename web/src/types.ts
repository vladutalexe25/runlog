export type NodeType = "http_request" | "transform" | "condition" | "delay" | "llm";

export const NODE_TYPES: NodeType[] = ["http_request", "transform", "condition", "delay", "llm"];

export interface WorkflowNode {
  id: string;
  type: NodeType;
  name: string;
  config: Record<string, unknown>;
  positionX: number;
  positionY: number;
}

export interface WorkflowEdge {
  id: string;
  sourceNodeId: string;
  targetNodeId: string;
  branch: "true" | "false" | null;
}

export interface Workflow {
  id: string;
  name: string;
  description: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface WorkflowGraph {
  workflow: Workflow;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
}

export type RunStatus = "pending" | "running" | "succeeded" | "failed";

export interface Run {
  id: string;
  workflowId: string;
  status: RunStatus;
  triggerType: "manual" | "webhook";
  triggerPayload: unknown;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export type NodeExecutionStatus = "pending" | "running" | "succeeded" | "failed" | "skipped";

export interface NodeExecution {
  id: string;
  runId: string;
  nodeId: string;
  status: NodeExecutionStatus;
  attempt: number;
  input: unknown;
  output: unknown;
  error: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
}

export interface RunDetail {
  run: Run;
  nodeExecutions: NodeExecution[];
}

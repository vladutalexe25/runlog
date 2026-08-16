import type { Run, RunDetail, Workflow, WorkflowEdge, WorkflowGraph, WorkflowNode } from "./types";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const detail = body.errors ? body.errors.join("; ") : (body.error ?? res.statusText);
    throw new Error(detail);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

export interface WorkflowInput {
  name: string;
  description?: string;
  nodes: Pick<WorkflowNode, "id" | "type" | "name" | "config" | "positionX" | "positionY">[];
  edges: { id: string; source: string; target: string; branch?: "true" | "false" }[];
}

export const api = {
  listWorkflows: () => request<Workflow[]>("/api/workflows"),
  getWorkflow: (id: string) => request<WorkflowGraph>(`/api/workflows/${id}`),
  createWorkflow: (input: WorkflowInput) =>
    request<Workflow>("/api/workflows", { method: "POST", body: JSON.stringify(input) }),
  updateWorkflow: (id: string, input: WorkflowInput) =>
    request<Workflow>(`/api/workflows/${id}`, { method: "PUT", body: JSON.stringify(input) }),
  triggerWorkflow: (id: string, payload: unknown) =>
    request<Run>(`/api/workflows/${id}/trigger`, { method: "POST", body: JSON.stringify(payload ?? {}) }),
  listRuns: (workflowId: string) => request<Run[]>(`/api/workflows/${workflowId}/runs`),
  getRun: (runId: string) => request<RunDetail>(`/api/runs/${runId}`),
  deleteWorkflow: (id: string) => request<void>(`/api/workflows/${id}`, { method: "DELETE" }),
  clearRunHistory: (workflowId: string) =>
    request<{ deleted: number }>(`/api/workflows/${workflowId}/runs`, { method: "DELETE" }),
};

export function edgesToApiShape(edges: WorkflowEdge[]) {
  return edges.map((e) => ({
    id: e.id,
    source: e.sourceNodeId,
    target: e.targetNodeId,
    branch: e.branch ?? undefined,
  }));
}

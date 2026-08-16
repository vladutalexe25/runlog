import { randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { db } from "./client.js";
import { edges, nodeExecutions, nodes, runs, workflows } from "./schema.js";
import type { NodeExecutionResult, RunResult, TriggerPayload, WorkflowDefinition } from "../engine/types.js";

export interface CreateWorkflowNodeInput {
  id: string;
  type: "http_request" | "transform" | "condition" | "delay" | "llm";
  name: string;
  config: Record<string, unknown>;
  positionX?: number;
  positionY?: number;
}

export interface CreateWorkflowEdgeInput {
  id: string;
  source: string;
  target: string;
  branch?: "true" | "false";
}

export interface CreateWorkflowInput {
  name: string;
  description?: string;
  nodes: CreateWorkflowNodeInput[];
  edges: CreateWorkflowEdgeInput[];
}

export async function createWorkflow(input: CreateWorkflowInput) {
  return db.transaction(async (tx) => {
    const [workflow] = await tx
      .insert(workflows)
      .values({ name: input.name, description: input.description })
      .returning();
    if (!workflow) throw new Error("failed to create workflow");

    if (input.nodes.length > 0) {
      await tx.insert(nodes).values(
        input.nodes.map((n) => ({
          id: n.id,
          workflowId: workflow.id,
          type: n.type,
          name: n.name,
          config: n.config,
          positionX: n.positionX ?? 0,
          positionY: n.positionY ?? 0,
        })),
      );
    }

    if (input.edges.length > 0) {
      await tx.insert(edges).values(
        input.edges.map((e) => ({
          id: e.id,
          workflowId: workflow.id,
          sourceNodeId: e.source,
          targetNodeId: e.target,
          branch: e.branch ?? null,
        })),
      );
    }

    return workflow;
  });
}

/**
 * Full replace: drops the workflow's current nodes (edges cascade with
 * them) and re-inserts whatever the editor sent. Simple and correct for a
 * single-user tool with no concurrent editors and no versioning — see
 * DECISIONS.md.
 */
export async function updateWorkflow(workflowId: string, input: CreateWorkflowInput) {
  return db.transaction(async (tx) => {
    const [workflow] = await tx
      .update(workflows)
      .set({ name: input.name, description: input.description, updatedAt: new Date() })
      .where(eq(workflows.id, workflowId))
      .returning();
    if (!workflow) return null;

    await tx.delete(nodes).where(eq(nodes.workflowId, workflowId));

    if (input.nodes.length > 0) {
      await tx.insert(nodes).values(
        input.nodes.map((n) => ({
          id: n.id,
          workflowId,
          type: n.type,
          name: n.name,
          config: n.config,
          positionX: n.positionX ?? 0,
          positionY: n.positionY ?? 0,
        })),
      );
    }

    if (input.edges.length > 0) {
      await tx.insert(edges).values(
        input.edges.map((e) => ({
          id: e.id,
          workflowId,
          sourceNodeId: e.source,
          targetNodeId: e.target,
          branch: e.branch ?? null,
        })),
      );
    }

    return workflow;
  });
}

export async function listWorkflows() {
  return db.select().from(workflows).orderBy(desc(workflows.createdAt));
}

/**
 * Deletes a workflow and everything under it — nodes, edges, runs, and
 * their node_executions all cascade from workflows.id / runs.id foreign
 * keys, so this is the one statement that needs to run.
 */
export async function deleteWorkflow(workflowId: string): Promise<boolean> {
  const deleted = await db.delete(workflows).where(eq(workflows.id, workflowId)).returning({ id: workflows.id });
  return deleted.length > 0;
}

export async function getWorkflowWithGraph(workflowId: string) {
  const [workflow] = await db.select().from(workflows).where(eq(workflows.id, workflowId));
  if (!workflow) return null;

  const [workflowNodes, workflowEdges] = await Promise.all([
    db.select().from(nodes).where(eq(nodes.workflowId, workflowId)),
    db.select().from(edges).where(eq(edges.workflowId, workflowId)),
  ]);

  return { workflow, nodes: workflowNodes, edges: workflowEdges };
}

/** Converts the persisted graph into the shape the pure execution engine expects. */
export function toWorkflowDefinition(
  workflowId: string,
  workflowNodes: (typeof nodes.$inferSelect)[],
  workflowEdges: (typeof edges.$inferSelect)[],
): WorkflowDefinition {
  return {
    id: workflowId,
    nodes: workflowNodes.map((n) => ({
      id: n.id,
      type: n.type,
      name: n.name,
      config: n.config as Record<string, unknown>,
    })),
    edges: workflowEdges.map((e) => ({
      id: e.id,
      source: e.sourceNodeId,
      target: e.targetNodeId,
      branch: (e.branch as "true" | "false" | null) ?? undefined,
    })),
  };
}

export async function enqueueRun(
  workflowId: string,
  triggerType: "manual" | "webhook",
  triggerPayload: TriggerPayload,
) {
  const [run] = await db
    .insert(runs)
    .values({ id: randomUUID(), workflowId, triggerType, triggerPayload: triggerPayload ?? {}, status: "pending" })
    .returning();
  if (!run) throw new Error("failed to enqueue run");
  return run;
}

export async function getRunWithExecutions(runId: string) {
  const [run] = await db.select().from(runs).where(eq(runs.id, runId));
  if (!run) return null;

  const executions = await db
    .select()
    .from(nodeExecutions)
    .where(eq(nodeExecutions.runId, runId))
    .orderBy(nodeExecutions.startedAt);

  return { run, nodeExecutions: executions };
}

export async function listRunsForWorkflow(workflowId: string) {
  return db.select().from(runs).where(eq(runs.workflowId, workflowId)).orderBy(desc(runs.createdAt));
}

/**
 * Atomically claims the oldest pending run so two workers can never process
 * the same one: `FOR UPDATE SKIP LOCKED` lets a second poller skip past a
 * row a concurrent transaction already has locked, instead of blocking on it.
 */
export async function claimNextPendingRun() {
  return db.transaction(async (tx) => {
    const claimable = await tx
      .select({ id: runs.id })
      .from(runs)
      .where(eq(runs.status, "pending"))
      .orderBy(runs.createdAt)
      .limit(1)
      .for("update", { skipLocked: true });
    const row = claimable[0];
    if (!row) return null;

    const [claimed] = await tx
      .update(runs)
      .set({ status: "running", startedAt: new Date() })
      .where(and(eq(runs.id, row.id), eq(runs.status, "pending")))
      .returning();

    return claimed ?? null;
  });
}

export async function recordRunResult(runId: string, result: RunResult) {
  await db.transaction(async (tx) => {
    await tx
      .update(runs)
      .set({ status: result.status, error: result.error, finishedAt: result.finishedAt })
      .where(eq(runs.id, runId));

    if (result.nodeExecutions.length > 0) {
      await tx.insert(nodeExecutions).values(
        result.nodeExecutions.map((exec: NodeExecutionResult) => ({
          runId,
          nodeId: exec.nodeId,
          status: exec.status,
          attempt: exec.attempts,
          input: exec.input ?? {},
          output: exec.output ?? null,
          error: exec.error,
          startedAt: exec.startedAt,
          finishedAt: exec.finishedAt,
          durationMs: exec.durationMs,
        })),
      );
    }
  });
}

export async function markRunFailed(runId: string, error: string) {
  await db.update(runs).set({ status: "failed", error, finishedAt: new Date() }).where(eq(runs.id, runId));
}

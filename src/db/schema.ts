import {
  pgTable,
  uuid,
  text,
  timestamp,
  jsonb,
  integer,
  doublePrecision,
  pgEnum,
} from "drizzle-orm/pg-core";

export const nodeTypeEnum = pgEnum("node_type", [
  "http_request",
  "transform",
  "condition",
  "delay",
  "llm",
]);

export const triggerTypeEnum = pgEnum("trigger_type", ["manual", "webhook"]);

export const runStatusEnum = pgEnum("run_status", [
  "pending",
  "running",
  "succeeded",
  "failed",
]);

export const nodeExecutionStatusEnum = pgEnum("node_execution_status", [
  "pending",
  "running",
  "succeeded",
  "failed",
  "skipped",
]);

export const workflows = pgTable("workflows", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  description: text("description"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const nodes = pgTable("nodes", {
  id: uuid("id").primaryKey().defaultRandom(),
  workflowId: uuid("workflow_id")
    .notNull()
    .references(() => workflows.id, { onDelete: "cascade" }),
  type: nodeTypeEnum("type").notNull(),
  name: text("name").notNull(),
  // Node-specific configuration, e.g. { url, method } for http_request,
  // { expression } for transform/condition, { ms } for delay.
  config: jsonb("config").notNull().default({}),
  positionX: doublePrecision("position_x").notNull().default(0),
  positionY: doublePrecision("position_y").notNull().default(0),
});

export const edges = pgTable("edges", {
  id: uuid("id").primaryKey().defaultRandom(),
  workflowId: uuid("workflow_id")
    .notNull()
    .references(() => workflows.id, { onDelete: "cascade" }),
  sourceNodeId: uuid("source_node_id")
    .notNull()
    .references(() => nodes.id, { onDelete: "cascade" }),
  targetNodeId: uuid("target_node_id")
    .notNull()
    .references(() => nodes.id, { onDelete: "cascade" }),
  // Only set when the source is a `condition` node: "true" | "false".
  // Null for every other edge, including all edges out of non-condition nodes.
  branch: text("branch"),
});

export const runs = pgTable("runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  workflowId: uuid("workflow_id")
    .notNull()
    .references(() => workflows.id, { onDelete: "cascade" }),
  status: runStatusEnum("status").notNull().default("pending"),
  triggerType: triggerTypeEnum("trigger_type").notNull(),
  triggerPayload: jsonb("trigger_payload").notNull().default({}),
  error: text("error"),
  startedAt: timestamp("started_at", { withTimezone: true }),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
});

export const nodeExecutions = pgTable("node_executions", {
  id: uuid("id").primaryKey().defaultRandom(),
  runId: uuid("run_id")
    .notNull()
    .references(() => runs.id, { onDelete: "cascade" }),
  nodeId: uuid("node_id")
    .notNull()
    .references(() => nodes.id, { onDelete: "cascade" }),
  status: nodeExecutionStatusEnum("status").notNull().default("pending"),
  attempt: integer("attempt").notNull().default(1),
  input: jsonb("input").notNull().default({}),
  output: jsonb("output"),
  error: text("error"),
  startedAt: timestamp("started_at", { withTimezone: true }),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  durationMs: integer("duration_ms"),
});

import {
  pgTable,
  uuid,
  text,
  timestamp,
  jsonb,
  integer,
  doublePrecision,
  pgEnum,
  primaryKey,
  foreignKey,
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

export const nodes = pgTable(
  "nodes",
  {
    // Client-supplied, not generated: workflow authors (and, later, the
    // editor) reference nodes by a stable key like "fetch" or "cond", and
    // edges/expressions read a lot more clearly that way than by uuid.
    // Only unique *within* a workflow, not globally — every workflow will
    // naturally have nodes named things like "extract" or "cond".
    id: text("id").notNull(),
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
  },
  (table) => [primaryKey({ columns: [table.workflowId, table.id] })],
);

export const edges = pgTable(
  "edges",
  {
    id: text("id").notNull(),
    workflowId: uuid("workflow_id")
      .notNull()
      .references(() => workflows.id, { onDelete: "cascade" }),
    sourceNodeId: text("source_node_id").notNull(),
    targetNodeId: text("target_node_id").notNull(),
    // Only set when the source is a `condition` node: "true" | "false".
    // Null for every other edge, including all edges out of non-condition nodes.
    branch: text("branch"),
  },
  (table) => [
    primaryKey({ columns: [table.workflowId, table.id] }),
    foreignKey({
      columns: [table.workflowId, table.sourceNodeId],
      foreignColumns: [nodes.workflowId, nodes.id],
      name: "edges_source_node_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.workflowId, table.targetNodeId],
      foreignColumns: [nodes.workflowId, nodes.id],
      name: "edges_target_node_fk",
    }).onDelete("cascade"),
  ],
);

export const runs = pgTable("runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  workflowId: uuid("workflow_id")
    .notNull()
    .references(() => workflows.id, { onDelete: "cascade" }),
  status: runStatusEnum("status").notNull().default("pending"),
  triggerType: triggerTypeEnum("trigger_type").notNull(),
  triggerPayload: jsonb("trigger_payload").notNull().default({}),
  error: text("error"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  startedAt: timestamp("started_at", { withTimezone: true }),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
});

export const nodeExecutions = pgTable("node_executions", {
  id: uuid("id").primaryKey().defaultRandom(),
  runId: uuid("run_id")
    .notNull()
    .references(() => runs.id, { onDelete: "cascade" }),
  // Not a foreign key: this is a historical record of which node ran, by the
  // id it had at run time. It must survive the node being renamed or removed
  // from the workflow later — only the parent run's deletion should cascade here.
  nodeId: text("node_id").notNull(),
  status: nodeExecutionStatusEnum("status").notNull().default("pending"),
  attempt: integer("attempt").notNull().default(1),
  input: jsonb("input").notNull().default({}),
  output: jsonb("output"),
  error: text("error"),
  startedAt: timestamp("started_at", { withTimezone: true }),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  durationMs: integer("duration_ms"),
});

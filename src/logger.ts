/**
 * Minimal structured logger: one JSON object per line to stdout/stderr.
 * The point isn't the implementation — it's that every log line about a
 * run carries the same `runId` field, so `grep runId` (or a log
 * aggregator's equivalent query) gets you that run's entire lifecycle in
 * order: enqueued, claimed, per-node detail via the stored run record,
 * finished. Plain `console.log("[run x] ...")` strings work for a human
 * skimming one terminal; they don't work for "find everything about this
 * run" once there's more than one source of log lines.
 */

type Level = "info" | "warn" | "error";

export interface LogFields {
  runId?: string;
  workflowId?: string;
  nodeId?: string;
  [key: string]: unknown;
}

function emit(level: Level, msg: string, fields: LogFields): void {
  const line = JSON.stringify({ time: new Date().toISOString(), level, msg, ...fields });
  if (level === "error") {
    console.error(line);
  } else {
    console.log(line);
  }
}

export const logger = {
  info: (msg: string, fields: LogFields = {}) => emit("info", msg, fields),
  warn: (msg: string, fields: LogFields = {}) => emit("warn", msg, fields),
  error: (msg: string, fields: LogFields = {}) => emit("error", msg, fields),
};

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { ReactFlow, Background, Controls, useNodesState, useEdgesState, type Edge } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { api } from "../api";
import type { NodeExecution, Run, RunStatus, WorkflowGraph } from "../types";
import FlowNode, { type FlowNodeType } from "../components/FlowNode";

const nodeTypes = { workflowNode: FlowNode };
const ACTIVE_STATUSES: RunStatus[] = ["pending", "running"];
const RENDERABLE_STATUSES = ["succeeded", "failed", "skipped"] as const;

function toRenderableStatus(status: string | undefined): (typeof RENDERABLE_STATUSES)[number] | null {
  return (RENDERABLE_STATUSES as readonly string[]).includes(status ?? "")
    ? (status as (typeof RENDERABLE_STATUSES)[number])
    : null;
}

function statusBadge(status: string) {
  return <span className={`badge badge-${status}`}>{status}</span>;
}

export default function WorkflowDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [graph, setGraph] = useState<WorkflowGraph | null>(null);
  const [runs, setRuns] = useState<Run[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [executions, setExecutions] = useState<NodeExecution[] | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [triggerPayload, setTriggerPayload] = useState("{}");
  const [triggering, setTriggering] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [nodes, setNodes, onNodesChange] = useNodesState<FlowNodeType>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = useCallback(() => {
    if (!id) return;
    Promise.all([api.getWorkflow(id), api.listRuns(id)])
      .then(([g, r]) => {
        setGraph(g);
        setRuns(r);
      })
      .catch((err) => setError(err.message));
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (!graph) return;
    const execByNode = new Map(executions?.map((e) => [e.nodeId, e]));
    setNodes(
      graph.nodes.map((n) => ({
        id: n.id,
        type: "workflowNode",
        position: { x: n.positionX, y: n.positionY },
        data: { label: n.name, nodeType: n.type, status: toRenderableStatus(execByNode.get(n.id)?.status) },
      })),
    );
    setEdges(
      graph.edges.map((e) => ({
        id: e.id,
        source: e.sourceNodeId,
        target: e.targetNodeId,
        sourceHandle: e.branch ?? undefined,
        label: e.branch ?? undefined,
      })),
    );
  }, [graph, executions, setNodes, setEdges]);

  const selectRun = useCallback((runId: string) => {
    setSelectedRunId(runId);
    setSelectedNodeId(null);
    api
      .getRun(runId)
      .then((detail) => setExecutions(detail.nodeExecutions))
      .catch((err) => setError(err.message));
  }, []);

  // Poll the selected run while it's still in flight, so a triggered run's
  // node statuses light up on the canvas without a manual refresh.
  useEffect(() => {
    if (pollRef.current) clearInterval(pollRef.current);
    if (!selectedRunId) return;
    const run = runs.find((r) => r.id === selectedRunId);
    if (!run || !ACTIVE_STATUSES.includes(run.status)) return;

    pollRef.current = setInterval(async () => {
      const detail = await api.getRun(selectedRunId);
      setExecutions(detail.nodeExecutions);
      setRuns((rs) => rs.map((r) => (r.id === selectedRunId ? detail.run : r)));
      if (!ACTIVE_STATUSES.includes(detail.run.status) && pollRef.current) {
        clearInterval(pollRef.current);
      }
    }, 1200);

    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [selectedRunId, runs]);

  const handleTrigger = async () => {
    if (!id) return;
    setError(null);
    let payload: unknown = {};
    try {
      payload = triggerPayload.trim() ? JSON.parse(triggerPayload) : {};
    } catch {
      setError("Trigger payload must be valid JSON.");
      return;
    }
    setTriggering(true);
    try {
      const run = await api.triggerWorkflow(id, payload);
      setRuns((rs) => [run, ...rs]);
      selectRun(run.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setTriggering(false);
    }
  };

  const handleDelete = async () => {
    if (!id || !graph) return;
    if (!confirm(`Delete "${graph.workflow.name}"? This also deletes its run history. This can't be undone.`)) {
      return;
    }
    try {
      await api.deleteWorkflow(id);
      navigate("/");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const isFinished = (r: Run) => r.status === "succeeded" || r.status === "failed";

  const handleClearHistory = async () => {
    if (!id) return;
    const clearableCount = runs.filter(isFinished).length;
    if (clearableCount === 0) return;
    if (!confirm(`Clear ${clearableCount} finished run(s) from history? This can't be undone.`)) return;
    try {
      await api.clearRunHistory(id);
      const selectedRunCleared = runs.find((r) => r.id === selectedRunId && isFinished(r));
      setRuns((rs) => rs.filter((r) => !isFinished(r)));
      if (selectedRunCleared) {
        setSelectedRunId(null);
        setExecutions(null);
        setSelectedNodeId(null);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const selectedExecution = useMemo(
    () => executions?.find((e) => e.nodeId === selectedNodeId) ?? null,
    [executions, selectedNodeId],
  );

  const webhookUrl = id ? `${window.location.origin}/webhooks/${id}` : "";

  if (error && !graph) return <div className="page error-banner">{error}</div>;
  if (!graph) return <div className="page">Loading…</div>;

  return (
    <div className="page detail-page" style={{ maxWidth: 1300 }}>
      <div className="page-header">
        <div>
          <h1>{graph.workflow.name}</h1>
          {graph.workflow.description && <div className="workflow-row-meta">{graph.workflow.description}</div>}
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <Link to={`/workflows/${id}/edit`} className="btn">
            Edit
          </Link>
          <button className="btn btn-danger" onClick={handleDelete}>
            Delete
          </button>
        </div>
      </div>

      {error && <div className="error-banner">{error}</div>}

      <div className="detail-layout">
        <div className="detail-canvas">
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            nodeTypes={nodeTypes}
            nodesDraggable={false}
            nodesConnectable={false}
            onNodeClick={(_, n) => setSelectedNodeId(n.id)}
            onPaneClick={() => setSelectedNodeId(null)}
            fitView
          >
            <Background />
            <Controls showInteractive={false} />
          </ReactFlow>
        </div>

        <div className="detail-sidebar">
          <div className="card trigger-card" style={{ padding: 12 }}>
            <div className="section-title">Trigger</div>
            <div className="field">
              <label>Webhook URL</label>
              <div className="webhook-url">{webhookUrl}</div>
            </div>
            <div className="field">
              <label>Payload (JSON)</label>
              <textarea value={triggerPayload} onChange={(e) => setTriggerPayload(e.target.value)} />
            </div>
            <button className="btn btn-primary" onClick={handleTrigger} disabled={triggering}>
              {triggering ? "Triggering…" : "Run now"}
            </button>
          </div>

          <div className="card run-history-card" style={{ padding: 12 }}>
            <div className="run-history-header">
              <div className="section-title">Run history</div>
              <button
                className="btn btn-danger"
                style={{ padding: "3px 8px", fontSize: 11 }}
                onClick={handleClearHistory}
                disabled={!runs.some(isFinished)}
              >
                Clear history
              </button>
            </div>
            <div className="run-history-list">
              {runs.length === 0 && <p style={{ fontSize: 12, color: "var(--text-dim)" }}>No runs yet.</p>}
              {runs.map((r) => (
                <div
                  key={r.id}
                  className={`run-row${r.id === selectedRunId ? " selected" : ""}`}
                  onClick={() => selectRun(r.id)}
                >
                  <div>
                    {statusBadge(r.status)}
                    <div className="run-meta">{r.triggerType}</div>
                  </div>
                  <div className="run-meta">{new Date(r.createdAt).toLocaleTimeString()}</div>
                </div>
              ))}
            </div>
          </div>

          {selectedExecution && (
            <div className="node-inspector">
              <div className="section-title">
                {selectedExecution.nodeId} {statusBadge(selectedExecution.status)}
              </div>
              {selectedExecution.error && <div className="error-text">{selectedExecution.error}</div>}
              <div style={{ fontSize: 11, color: "var(--text-dim)", margin: "6px 0" }}>
                {selectedExecution.attempt} attempt(s) · {selectedExecution.durationMs ?? 0}ms
              </div>
              <label style={{ fontSize: 10, color: "var(--text-dim)" }}>Input</label>
              <pre>{JSON.stringify(selectedExecution.input, null, 2)}</pre>
              <label style={{ fontSize: 10, color: "var(--text-dim)" }}>Output</label>
              <pre>{JSON.stringify(selectedExecution.output, null, 2)}</pre>
            </div>
          )}

          {selectedRunId && !selectedExecution && (
            <p style={{ fontSize: 12, color: "var(--text-dim)" }}>Click a node on the canvas to inspect it.</p>
          )}
        </div>
      </div>
    </div>
  );
}
